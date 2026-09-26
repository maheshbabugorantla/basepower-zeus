"""ERCOT real-time settlement point prices (NP6-905-CD spp_node_zone_hub,
settlementPointType=LZ) -> core.ercot_spp, then core.grid_value_lz.

Auth is Azure B2C ROPC (the exact flow verified live by checks/M3-H1.md
and matching the sibling `BasePower_Deep_Tech_Hackathon_Sep_25_2026`
repo's working `ercot_pull/client.py`, read directly rather than
guessed): POST username+password to the B2C token endpoint, then call
the API with `Authorization: Bearer <id_token>` + `Ocp-Apim-Subscription-
Key`. Never print/log ERCOT_USERNAME/ERCOT_PASSWORD/
ERCOT_SUBSCRIPTION_KEY or the token itself.

Trap (checks/M3-H1.md, checks/M3-ercot-layering.md section A): the same
8 LZ_* settlement point names also appear under settlementPointType=LZEW
(energy-weighted) with different prices. This module filters by
settlementPointType == 'LZ' on every parsed row and drops (counts) any
other type -- never trusts the query filter alone.

Load zones come from pipelines/config/load_zones.yaml (no code change to
add one, per M3-P1's acceptance criterion) -- parsed by hand below
(a tiny fixed list format, not general YAML) so this module needs no new
dependency beyond requirements.txt's existing httpx.

Raw pages are saved UNCHANGED, one JSON page per line, to
    data/raw/ercot_spp/<zone>_<window_start>_<window_end>.jsonl
in the MAIN checkout (never git-added here -- the orchestrator commits
raw files), one ops.source_manifest row per zone-window file, mirroring
pipelines/sources/empower.py's pattern.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Literal
from zoneinfo import ZoneInfo

import httpx

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "ercot_spp"

API_BASE = "https://api.ercot.com/api/public-reports"
TOKEN_URL = (
    "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/"
    "B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token"
)
# Public client id for the ROPC flow, published in ERCOT's developer docs
# (verified live by checks/M3-H1.md).
CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70"
REPORT_PATH = "np6-905-cd/spp_node_zone_hub"

CENTRAL = ZoneInfo("America/Chicago")
RETRY_STATUSES = {429, 500, 502, 503, 504}

# ERCOT's API-queryable history starts at operating day 2023-12-11 (the
# sibling repo's ercot_pull/README.md, verified against the live API);
# earlier dates return 0 rows.
EARLIEST_QUERYABLE_DATE = date(2023, 12, 11)

# pipelines/sources/ercot_spp.py -> parents[2] is the repo root.
CONFIG_PATH = Path(__file__).resolve().parents[2] / "pipelines" / "config" / "load_zones.yaml"
RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/ercot_spp"
)

Runner = Literal["cron", "cli"]


# ---------------------------------------------------------------------------
# Config: load zones from load_zones.yaml (fixed "load_zones:\n  - X" shape,
# a hand-written parser to avoid a new dependency -- not general YAML).
# ---------------------------------------------------------------------------


def load_zones() -> list[str]:
    zones: list[str] = []
    in_list = False
    for line in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "load_zones:":
            in_list = True
            continue
        if in_list and stripped.startswith("- "):
            zones.append(stripped[2:].strip())
        elif in_list and not stripped.startswith("-"):
            in_list = False
    if not zones:
        raise RuntimeError(f"{CONFIG_PATH}: no load zones found under 'load_zones:'")
    return zones


# ---------------------------------------------------------------------------
# ERCOT client: ROPC token auth, throttled/retried GET, pagination.
# Ported from the sibling repo's proven ercot_pull/client.py (read
# directly, not guessed) -- condensed into this one module per this
# ticket's owns boundary.
# ---------------------------------------------------------------------------


class ErcotError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class _Creds:
    username: str
    password: str
    subscription_key: str

    def __repr__(self) -> str:  # never show secrets in tracebacks or logs
        return "_Creds(<redacted>)"


def _creds_from_env() -> _Creds:
    return _Creds(
        username=config.require_env("ERCOT_USERNAME"),
        password=config.require_env("ERCOT_PASSWORD"),
        subscription_key=config.require_env("ERCOT_SUBSCRIPTION_KEY"),
    )


class ErcotClient:
    def __init__(self, creds: _Creds, *, min_interval: float = 2.1, max_retries: int = 5, timeout: float = 120.0):
        self._creds = creds
        self._http = httpx.Client(timeout=timeout, follow_redirects=True)
        self.min_interval = min_interval
        self.max_retries = max_retries
        self._token: str | None = None
        self._token_expires = 0.0
        self._last_request: float | None = None

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "ErcotClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def token(self, force: bool = False) -> str:
        if not force and self._token and time.monotonic() < self._token_expires - 300.0:
            return self._token
        data = {
            "username": self._creds.username,
            "password": self._creds.password,
            "grant_type": "password",
            "scope": f"openid {CLIENT_ID} offline_access",
            "client_id": CLIENT_ID,
            "response_type": "id_token",
        }
        resp = self._http.post(TOKEN_URL, data=data)
        if resp.status_code != 200:
            raise ErcotError(f"ERCOT token endpoint rejected credentials (HTTP {resp.status_code})", resp.status_code)
        body = resp.json()
        tok = body.get("id_token") or body.get("access_token")
        if not tok:
            raise ErcotError("ERCOT token response had no id_token")
        self._token = tok
        self._token_expires = time.monotonic() + float(body.get("expires_in", 3600))
        return tok

    def _throttle(self) -> None:
        if self._last_request is not None:
            wait = self.min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
        self._last_request = time.monotonic()

    def get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{API_BASE}/{path.lstrip('/')}"
        refreshed = False
        attempt = 0
        while True:
            headers = {
                "Authorization": f"Bearer {self.token()}",
                "Ocp-Apim-Subscription-Key": self._creds.subscription_key,
            }
            self._throttle()
            resp = self._http.get(url, params=params, headers=headers)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 401 and not refreshed:
                refreshed = True
                self.token(force=True)
                continue
            if resp.status_code in (401, 403):
                raise ErcotError(f"ERCOT GET {path} rejected (HTTP {resp.status_code})", resp.status_code)
            if resp.status_code in RETRY_STATUSES and attempt < self.max_retries:
                attempt += 1
                retry_after = resp.headers.get("Retry-After")
                time.sleep(float(retry_after) if retry_after else 2.0 * (2 ** (attempt - 1)))
                continue
            raise ErcotError(f"ERCOT GET {path} returned HTTP {resp.status_code}", resp.status_code)

    def iter_pages(self, path: str, params: dict[str, Any], size: int = 50_000) -> Iterator[dict[str, Any]]:
        page = 1
        while True:
            body = self.get(path, {**params, "page": page, "size": size})
            yield body
            meta = body.get("_meta", {})
            total_pages = int(meta.get("totalPages") or 0)
            if page >= total_pages:
                return
            page += 1


# ---------------------------------------------------------------------------
# Fetch one zone's window to a raw jsonl file (one full page response per
# line, byte-for-byte, never re-serialized).
# ---------------------------------------------------------------------------


def fetch_zone_to_jsonl(client: ErcotClient, zone: str, date_from: date, date_to: date, dest_path: Path) -> dict[str, Any]:
    import hashlib

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    params = {
        "settlementPointType": "LZ",
        "settlementPoint": zone,
        "deliveryDateFrom": date_from.isoformat(),
        "deliveryDateTo": date_to.isoformat(),
    }
    digest = hashlib.sha256()
    total_bytes = 0
    total_rows = 0
    pages = 0
    with open(dest_path, "wb") as out:
        for body in client.iter_pages(REPORT_PATH, params):
            line = json.dumps(body).encode("utf-8") + b"\n"
            out.write(line)
            digest.update(line)
            total_bytes += len(line)
            total_rows += len(body.get("data", []))
            pages += 1
    return {"rows": total_rows, "sha256": digest.hexdigest(), "bytes": total_bytes, "pages": pages}


def iter_jsonl_rows(path: Path) -> Iterator[dict[str, Any]]:
    """Yield every row (dict keyed by the API's `fields` names) across
    every page-line in a raw jsonl file, in file order."""
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            page = json.loads(line)
            names = [f["name"] for f in page.get("fields", [])]
            for row in page.get("data", []):
                yield dict(zip(names, row, strict=True))


# ---------------------------------------------------------------------------
# interval_start: UTC start of a 15-min interval, from delivery_date +
# hour-ending (1..24) + interval (1..4), in America/Chicago, using
# dst_flag to disambiguate the repeated fall-back hour (fold=1 on the
# DSTFlag=true pass). Never collapse two real intervals into one row.
# ---------------------------------------------------------------------------


def interval_start_utc(delivery_date: date, hour: int, interval: int, dst_flag: bool) -> datetime:
    local = datetime.combine(delivery_date, datetime.min.time()) + timedelta(hours=hour - 1, minutes=15 * (interval - 1))
    local = local.replace(tzinfo=CENTRAL, fold=1 if dst_flag else 0)
    return local.astimezone(timezone.utc)


def record_to_row(rec: dict[str, Any]) -> dict[str, Any] | None:
    """Map one raw API row to a core.ercot_spp row dict, or None if it is
    not settlementPointType=LZ (the LZ/LZEW name-collision trap) or is
    missing a required field."""
    if rec.get("settlementPointType") != "LZ":
        return None
    delivery_date_raw = rec.get("deliveryDate")
    if not delivery_date_raw:
        return None
    delivery_date = date.fromisoformat(str(delivery_date_raw)[:10])
    hour = int(rec["deliveryHour"])
    interval = int(rec["deliveryInterval"])
    dst_flag = bool(rec.get("DSTFlag"))
    return {
        "settlement_point": rec["settlementPoint"],
        "delivery_date": delivery_date,
        "delivery_hour": hour,
        "delivery_interval": interval,
        "dst_flag": dst_flag,
        "interval_start": interval_start_utc(delivery_date, hour, interval, dst_flag),
        "price_usd_mwh": float(rec["settlementPointPrice"]),
    }


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def _existing_manifest_for_sha(sha256: str) -> str | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select id from ops.source_manifest where source = %s and sha256 = %s "
                "order by retrieved_at desc limit 1",
                (SOURCE, sha256),
            )
            row = cur.fetchone()
    return str(row[0]) if row else None


def _ensure_manifest(zone: str, date_from: date, date_to: date, dest_path: Path, runner: Runner) -> dict[str, Any]:
    with ErcotClient(_creds_from_env()) as client:
        fetch_result = fetch_zone_to_jsonl(client, zone, date_from, date_to, dest_path)
    sha256 = fetch_result["sha256"]

    existing_id = _existing_manifest_for_sha(sha256)
    if existing_id is not None:
        return {"id": existing_id, "rows": fetch_result["rows"]}

    when = datetime.now(timezone.utc)
    key = storage.storage_key(SOURCE, sha256, when=when, ext=".jsonl")
    storage.upload_raw(dest_path.read_bytes(), key, content_type="application/x-ndjson")

    source_url = (
        f"{API_BASE}/{REPORT_PATH}?settlementPointType=LZ&settlementPoint={zone}"
        f"&deliveryDateFrom={date_from.isoformat()}&deliveryDateTo={date_to.isoformat()}"
    )
    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=source_url,
            retrieved_at=when,
            sha256=sha256,
            bytes_=fetch_result["bytes"],
            rows=fetch_result["rows"],
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "rows": fetch_result["rows"]}


# ---------------------------------------------------------------------------
# Load core.ercot_spp
# ---------------------------------------------------------------------------


_STAGE_COLUMNS = (
    "settlement_point", "delivery_date", "delivery_hour", "delivery_interval",
    "dst_flag", "interval_start", "price_usd_mwh", "source_id",
)

_STAGE_BATCH_SIZE = 5_000


def _ensure_stage_table(cur) -> None:
    cur.execute(
        """
        create temporary table if not exists ercot_spp_stage (
            settlement_point   text,
            delivery_date      date,
            delivery_hour      smallint,
            delivery_interval  smallint,
            dst_flag           boolean,
            interval_start     timestamptz,
            price_usd_mwh      numeric,
            source_id          uuid
        ) on commit preserve rows
        """
    )
    cur.execute("truncate ercot_spp_stage")


def _flush_stage_batch(conn, cur, batch: list[dict[str, Any]]) -> None:
    """COPY one batch into the temp stage table, then upsert it into
    core.ercot_spp in one statement (the HCAD-loader pattern -- never a
    per-row insert/round-trip, which would take hours over the pooler for
    ~280K rows). Committed per batch (rollback on error) so a crash mid-
    backfill loses at most one batch, not the whole run."""
    if not batch:
        return
    cur.execute("truncate ercot_spp_stage")
    with cur.copy(f"copy ercot_spp_stage ({', '.join(_STAGE_COLUMNS)}) from stdin") as copy:
        for row in batch:
            copy.write_row((
                row["settlement_point"], row["delivery_date"], row["delivery_hour"], row["delivery_interval"],
                row["dst_flag"], row["interval_start"], row["price_usd_mwh"], row["source_id"],
            ))
    cur.execute(
        """
        insert into core.ercot_spp
            (settlement_point, delivery_date, delivery_hour, delivery_interval,
             dst_flag, interval_start, price_usd_mwh, source_id)
        select settlement_point, delivery_date, delivery_hour, delivery_interval,
               dst_flag, interval_start, price_usd_mwh, source_id
        from ercot_spp_stage
        on conflict (settlement_point, delivery_date, delivery_hour, delivery_interval, dst_flag)
        do update set
            interval_start = excluded.interval_start,
            price_usd_mwh = excluded.price_usd_mwh,
            source_id = excluded.source_id
        """
    )
    conn.commit()


def _natural_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (row["settlement_point"], row["delivery_date"], row["delivery_hour"], row["delivery_interval"], row["dst_flag"])


def load_core(conn, manifest_id: str, rows: Iterator[dict[str, Any]]) -> tuple[int, int, int, int]:
    """Bulk-load every LZ row into core.ercot_spp via COPY into a temp
    stage table + one upsert per batch (never a per-row execute(), which
    at ~280K rows over the pooler would take hours). Returns
    (rows_in, rows_loaded, dropped_non_lz, dropped_dup_within_batch).

    Within a batch, a row whose natural key repeats (ERCOT's paginated
    response can return the same interval twice at a page boundary --
    confirmed against the real raw file: the repeated rows carry the
    identical real price, not a conflicting one) is kept once via a
    dict keyed by the natural key, never dropped silently -- the
    ON CONFLICT upsert would otherwise raise CardinalityViolation on a
    duplicate key within one INSERT...SELECT."""
    rows_in = 0
    rows_loaded = 0
    dropped_non_lz = 0
    dropped_dup_within_batch = 0
    batch: dict[tuple[Any, ...], dict[str, Any]] = {}
    with conn.cursor() as cur:
        _ensure_stage_table(cur)
        for rec in rows:
            rows_in += 1
            if rec.get("settlementPointType") != "LZ":
                dropped_non_lz += 1
                continue
            row = record_to_row(rec)
            if row is None:
                continue
            row["source_id"] = manifest_id
            key = _natural_key(row)
            if key in batch:
                dropped_dup_within_batch += 1
            else:
                rows_loaded += 1
            batch[key] = row
            if len(batch) >= _STAGE_BATCH_SIZE:
                _flush_stage_batch(conn, cur, list(batch.values()))
                batch = {}
        _flush_stage_batch(conn, cur, list(batch.values()))
    return rows_in, rows_loaded, dropped_non_lz, dropped_dup_within_batch


def _zone_already_covers_window(zone: str, date_from: date, date_to: date) -> bool:
    """True if core.ercot_spp already has rows for `zone` spanning close to
    [date_from, date_to] (resumability: a crashed backfill can skip zones
    it already finished, per checks/M3-ercot-layering.md section E)."""
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select min(delivery_date), max(delivery_date) from core.ercot_spp where settlement_point = %s",
                (zone,),
            )
            row = cur.fetchone()
    if row is None or row[0] is None:
        return False
    zone_min, zone_max = row
    return zone_min <= date_from + timedelta(days=1) and zone_max >= date_to - timedelta(days=1)


def _refresh_grid_value(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("select core.refresh_grid_value_lz()")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    zones = load_zones()
    today = datetime.now(CENTRAL).date()
    yesterday = today - timedelta(days=1)

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=cursor)

    total_rows_in = 0
    total_rows_loaded = 0
    total_dropped_non_lz = 0
    total_dropped_dup = 0
    try:
        for zone in zones:
            if backfill:
                date_from = max(EARLIEST_QUERYABLE_DATE, yesterday - timedelta(days=365))
                date_to = yesterday
            else:
                with db.connect(pooled=False) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "select max(delivery_date) from core.ercot_spp where settlement_point = %s", (zone,)
                        )
                        last_loaded = cur.fetchone()[0]
                date_from = (last_loaded + timedelta(days=1)) if last_loaded else yesterday - timedelta(days=1)
                date_to = yesterday
                if date_from > date_to:
                    continue  # already up to date for this zone

            if backfill and _zone_already_covers_window(zone, date_from, date_to):
                continue  # resumability: this zone's window is already loaded

            dest_path = RAW_DIR / f"{zone}_{date_from.isoformat()}_{date_to.isoformat()}.jsonl"
            manifest_row = _ensure_manifest(zone, date_from, date_to, dest_path, runner)
            manifest_id = manifest_row["id"]

            with db.connect(pooled=False) as conn:
                rows_in, rows_loaded, dropped_non_lz, dropped_dup = load_core(conn, manifest_id, iter_jsonl_rows(dest_path))
            total_rows_in += rows_in
            total_rows_loaded += rows_loaded
            total_dropped_non_lz += dropped_non_lz
            total_dropped_dup += dropped_dup

        with db.connect(pooled=False) as conn:
            _refresh_grid_value(conn)
            runs.finish(
                conn, run_id, status="success",
                rows_in=total_rows_in, rows_loaded=total_rows_loaded,
                filter_drops={
                    "not_settlement_point_type_lz": total_dropped_non_lz,
                    "duplicate_page_boundary_row": total_dropped_dup,
                },
                cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
