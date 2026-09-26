"""HHS emPOWER Map, ZIP level (ArcGIS FeatureServer layer 1) -> core.empower_zip.

Source (decided by M2-H3, see checks/M2-H3.md): a public, anonymous,
no-key ArcGIS Feature Service —

    https://services2.arcgis.com/ZQ4jTQn6k7VPXEwO/arcgis/rest/services/
        HHS_emPOWER_REST_Service_Public/FeatureServer/1/query

queried with `where=STATE='TX'`, `outFields=Zip_Code,Medicare_Benes,
Power_Dependent_Devices_DME`, `returnGeometry=false`, `f=json`. TX has
1850 rows today (checks/M2-H3.md), under the service's
`maxRecordCount=2000`, but this pages defensively with
`resultOffset`/`resultRecordCount` regardless, in case that ever changes.
There is no per-month field on the live layer — it always holds only the
current snapshot (see checks/M2-H3.md's Cadence section) — so the
manifest's `retrieved_at` is the only record of vintage.

Raw file: every page's response body is written UNCHANGED, one page's
raw JSON text per line (each line is Esri JSON's exact bytes for that
page — no re-serialization), to
    data/raw/empower/empower_tx_<YYYYMMDD>.jsonl
in the MAIN checkout (never git-added by this module — see
AGENTS/CLAUDE.md's real-data rule), alongside M2-H3's existing
2026_HHSemPOWERMapHistoricalDataset.xlsx. Sidecar lines (one per file,
so the existing xlsx entries are preserved, never overwritten) are
appended to SOURCE_URL.txt / retrieved_at.txt / SHA256SUMS in that same
directory.

Suppression (checks/M2-H3.md's Caveats): HHS masks any true count
between 1 and 10 and reports it as the literal integer 11. Any ZIP whose
`Power_Dependent_Devices_DME` (or, defensively, `Medicare_Benes`) comes
back as exactly 11 is stored as NULL with `empower_null_reason =
'suppressed_1_to_10'`, never the literal 11 — the real-data rule's
"missing means empty" applies here: 11 is not a count, an estimate, or a
zero, so it must never reach the loaded value column.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal

import httpx

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "empower"
BASE_URL = (
    "https://services2.arcgis.com/ZQ4jTQn6k7VPXEwO/arcgis/rest/services/"
    "HHS_emPOWER_REST_Service_Public/FeatureServer/1/query"
)
OUT_FIELDS = "Zip_Code,Medicare_Benes,Power_Dependent_Devices_DME"
WHERE = "STATE='TX'"
PAGE_SIZE = 1000
SUPPRESSED_VALUE = 11

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/empower"
)

Runner = Literal["cron", "cli"]


def source_url() -> str:
    """The exact query (minus the paging resultOffset, which increments
    per page from 0), for SOURCE_URL.txt."""
    return (
        f"{BASE_URL}?where={WHERE}&outFields={OUT_FIELDS}"
        f"&returnGeometry=false&resultRecordCount={PAGE_SIZE}&resultOffset=N&f=json"
    )


def _fetch_page_bytes(offset: int, *, client: httpx.Client) -> bytes:
    params = {
        "where": WHERE,
        "outFields": OUT_FIELDS,
        "returnGeometry": "false",
        "resultRecordCount": str(PAGE_SIZE),
        "resultOffset": str(offset),
        "f": "json",
    }
    resp = client.get(BASE_URL, params=params, timeout=120.0)
    resp.raise_for_status()
    return resp.content


def fetch_all_to_jsonl(dest_path: Path) -> dict[str, Any]:
    """Page through STATE='TX' with resultOffset, writing each page's raw
    response body UNCHANGED as one line in `dest_path` (a JSON-lines
    file: one full Esri-JSON page response per line, byte-for-byte as
    returned — never re-serialized). Stops when a page returns fewer than
    PAGE_SIZE features. Returns {rows, sha256, bytes, pages} — `rows` is
    the total feature count seen across all pages (computed by parsing
    each page's JSON only to count `features`, never to alter the raw
    bytes written to disk)."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total_bytes = 0
    total_rows = 0
    pages = 0
    offset = 0
    with httpx.Client(follow_redirects=True) as client, open(dest_path, "wb") as out:
        while True:
            body = _fetch_page_bytes(offset, client=client)
            parsed = json.loads(body)
            if "error" in parsed:
                raise RuntimeError(f"emPOWER REST error at offset {offset}: {parsed['error']}")
            features = parsed.get("features", [])
            line = body + b"\n"
            out.write(line)
            digest.update(line)
            total_bytes += len(line)
            total_rows += len(features)
            pages += 1
            if len(features) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
    return {"rows": total_rows, "sha256": digest.hexdigest(), "bytes": total_bytes, "pages": pages}


def _append_sidecars(dest_path: Path, retrieved_at: datetime, sha256: str) -> None:
    name = dest_path.name
    ts = retrieved_at.isoformat().replace("+00:00", "Z")
    with open(RAW_DIR / "SOURCE_URL.txt", "a") as f:
        f.write(f"{source_url()}  # {name}\n")
    with open(RAW_DIR / "retrieved_at.txt", "a") as f:
        f.write(f"{ts} {name}\n")
    with open(RAW_DIR / "SHA256SUMS", "a") as f:
        f.write(f"{sha256}  {name}\n")


def iter_jsonl_features(path: Path) -> Iterator[dict[str, Any]]:
    """Yield every feature's `attributes` dict across every page-line in
    the raw JSON-lines file, in file order."""
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            page = json.loads(line)
            for feature in page.get("features", []):
                yield feature.get("attributes", {})


# ---------------------------------------------------------------------------
# Manifest (reuse an existing row for the same sha256; else upload + insert)
# ---------------------------------------------------------------------------


def _existing_manifest(sha256: str) -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select id, storage_key from ops.source_manifest "
                "where source = %s and sha256 = %s order by retrieved_at desc limit 1",
                (SOURCE, sha256),
            )
            row = cur.fetchone()
    if row is None:
        return None
    return {"id": str(row[0]), "storage_key": row[1]}


def _upload_raw(content: bytes, key: str) -> None:
    base_url = config.supabase_url().rstrip("/")
    service_key = config.supabase_secret_key()
    url = f"{base_url}/storage/v1/object/{config.RAW_BUCKET}/{key}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/x-ndjson",
        "x-upsert": "true",
    }
    resp = httpx.post(url, headers=headers, content=content, timeout=120.0)
    resp.raise_for_status()


def _ensure_manifest(runner: Runner) -> dict[str, Any]:
    retrieved_at = datetime.now(timezone.utc)
    dest_path = RAW_DIR / f"empower_tx_{retrieved_at.strftime('%Y%m%d')}.jsonl"
    fetch_result = fetch_all_to_jsonl(dest_path)
    sha256 = fetch_result["sha256"]
    _append_sidecars(dest_path, retrieved_at, sha256)

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "dest_path": dest_path, "rows": fetch_result["rows"]}

    content = dest_path.read_bytes()
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".jsonl")
    _upload_raw(content, key)

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=source_url(),
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=fetch_result["bytes"],
            rows=fetch_result["rows"],
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "dest_path": dest_path, "rows": fetch_result["rows"]}


# ---------------------------------------------------------------------------
# Field mapping: feature attributes -> core.empower_zip row
# ---------------------------------------------------------------------------


def record_to_empower_row(attrs: dict[str, Any]) -> dict[str, Any] | None:
    """Map one raw feature's `attributes` dict to a core.empower_zip row
    dict, or None if it has no Zip_Code (the primary key — never
    invented). A count field whose raw value is exactly 11 (HHS's
    small-cell suppression sentinel for a true count of 1-10, per
    checks/M2-H3.md) is stored as NULL, never as the literal 11."""
    zip_code = attrs.get("Zip_Code")
    if not zip_code:
        return None
    zip_code = str(zip_code).strip()
    if not zip_code:
        return None

    medicare_benes = attrs.get("Medicare_Benes")
    dme = attrs.get("Power_Dependent_Devices_DME")

    medicare_suppressed = medicare_benes == SUPPRESSED_VALUE
    dme_suppressed = dme == SUPPRESSED_VALUE

    return {
        "zip_code": zip_code,
        "medicare_benes": None if medicare_suppressed else medicare_benes,
        "power_dependent_devices_dme": None if dme_suppressed else dme,
        "power_dependent_devices_dme_suppressed": dme_suppressed,
        "empower_null_reason": "suppressed_1_to_10" if (medicare_suppressed or dme_suppressed) else None,
    }


def load_core(conn, manifest_id: str, records: Iterator[dict[str, Any]]) -> tuple[int, int]:
    """Upsert every valid record into core.empower_zip. Returns
    (rows_in, rows_loaded)."""
    rows_in = 0
    rows_loaded = 0
    with conn.cursor() as cur:
        for attrs in records:
            rows_in += 1
            row = record_to_empower_row(attrs)
            if row is None:
                continue
            cur.execute(
                """
                insert into core.empower_zip
                    (zip_code, medicare_benes, power_dependent_devices_dme,
                     power_dependent_devices_dme_suppressed, empower_null_reason,
                     source_id, updated_at)
                values (%s, %s, %s, %s, %s, %s, now())
                on conflict (zip_code) do update set
                    medicare_benes = excluded.medicare_benes,
                    power_dependent_devices_dme = excluded.power_dependent_devices_dme,
                    power_dependent_devices_dme_suppressed = excluded.power_dependent_devices_dme_suppressed,
                    empower_null_reason = excluded.empower_null_reason,
                    source_id = excluded.source_id,
                    updated_at = now()
                """,
                (
                    row["zip_code"],
                    row["medicare_benes"],
                    row["power_dependent_devices_dme"],
                    row["power_dependent_devices_dme_suppressed"],
                    row["empower_null_reason"],
                    manifest_id,
                ),
            )
            rows_loaded += 1
    return rows_in, rows_loaded


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    manifest_row = _ensure_manifest(runner)
    manifest_id = manifest_row["id"]
    dest_path = manifest_row["dest_path"]

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=None)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

    try:
        with db.connect(pooled=False) as conn:
            rows_in, rows_loaded = load_core(conn, manifest_id, iter_jsonl_features(dest_path))

        filter_drops = {"missing_zip_code": rows_in - rows_loaded}
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=rows_loaded, filter_drops=filter_drops, cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
