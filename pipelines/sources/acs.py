"""Census ACS 5-year Detailed Tables API -> core.acs_bg, by block group,
for Travis (48453) and Harris (48201) counties.

Source: https://api.census.gov/data/<vintage>/acs/acs5, key CENSUS_API_KEY
(read via config.require_env, never logged/printed). `run()` probes
vintage 2024 first, falling back to 2023 only if 2024's response for
EITHER county isn't a well-formed ACS payload (a bad key or missing
vintage can come back as an HTML page with a 200 status, so the probe
parses and checks the header, not just the status code — see
`_valid_payload`). One GET per county, all variables in a single call
(18, well under the API's 50-variable cap):

    tenure:    B25003_001E (total occupied housing units), _002E (owner),
               _003E (renter) -- fetched for provenance/traceability, but
               core.acs_bg (supabase/migrations/0201_m2.sql) has no tenure
               columns, so these three are never written to a column.
    age 65+:   B01001_001E (total population) plus male 020E-025E and
               female 044E-049E (the 65+ five-year age bins) -- summed
               into pop_65_plus.
    heating:   B25040_001E (total occupied housing units, heating-fuel
               universe) as housing_units_total, B25040_004E (utility gas
               ... electricity) as heating_electric.

Raw files: each county's response body is written UNCHANGED to
    data/raw/acs/{travis,harris}.json
in the MAIN checkout (never git-added by this module -- see AGENTS/
CLAUDE.md's real-data rule), with sidecars SOURCE_URL.txt (one line per
county, the exact query minus `key=...` -- the API key is never written
to disk, to a manifest row, or into any exception message; see
`source_url` and `_sanitize`), retrieved_at.txt, and SHA256SUMS. Each
county's bytes get their own ops.source_manifest row (reused, not
re-uploaded, if the same sha256 already has one) and their own
ops.pipeline_runs row.

Null/annotation handling (never invented, never a partial sum): the
Census API returns a negative sentinel (e.g. -666666666) or a JSON null
for a suppressed or unavailable cell. `_clean_count` treats any negative
value, `None`, or an unparseable string as absent and returns a reason
string. `_sum_components` (used for the 12-variable 65+ sum) returns
None for the WHOLE sum, with the first offending component's reason, if
ANY component is absent -- never a partial sum. core.acs_bg's raw counts
(pop_total, housing_units_total) have no *_null_reason column of their
own, so an absent value there is simply stored as NULL; pop_65_plus and
heating_electric each have a *_null_reason column, set accordingly.

Shares (acs_pct_65_plus, acs_pct_electric_heat) are NOT computed or
stored here -- core.acs_bg carries raw counts only, per its migration.
core.mv_home_signals (0201_m2.sql) derives each share from these raw
counts at refresh time, and already nulls the share (with its own
reason) when the relevant denominator (pop_total / housing_units_total)
is zero or null -- that "null when the denominator is 0" rule from the
ticket brief is implemented there, not duplicated in this module.

Never zero-fills: every block group the API returns is loaded, annotated
ones included (as NULL + reason, never 0), so filter_drops is always {}
and rows_loaded == rows_in for every run (checked by
`python -m pipelines.check reconcile --source acs`).
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode

import httpx

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "acs"

# Probe order: latest 5-year vintage first, fall back only on a bad response.
VINTAGES: tuple[int, ...] = (2024, 2023)

STATE_FIPS = "48"
# county_fips (core.acs_bg.county_fips) -> 3-digit county code for the API's `in=` clause
COUNTIES: dict[str, str] = {"48453": "453", "48201": "201"}
COUNTY_FILE_NAMES: dict[str, str] = {"48453": "travis", "48201": "harris"}

VARIABLES: list[str] = [
    "NAME",
    "B25040_001E", "B25040_004E",
    "B01001_001E",
    "B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E", "B01001_024E", "B01001_025E",
    "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E", "B01001_048E", "B01001_049E",
    "B25003_001E", "B25003_002E", "B25003_003E",
]
AGE65_VARS: tuple[str, ...] = (
    "B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E", "B01001_024E", "B01001_025E",
    "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E", "B01001_048E", "B01001_049E",
)
GEO_COLS = ("state", "county", "tract", "block group")

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/acs"
)

INSERT_CHUNK = 300
Runner = Literal["cron", "cli"]


# ---------------------------------------------------------------------------
# Query construction / fetch (key never stored, logged, or echoed)
# ---------------------------------------------------------------------------


def _census_base_url(vintage: int) -> str:
    return f"https://api.census.gov/data/{vintage}/acs/acs5"


def _query_params(county_code3: str) -> dict[str, str]:
    return {
        "get": ",".join(VARIABLES),
        "for": "block group:*",
        "in": f"state:{STATE_FIPS} county:{county_code3}",
    }


def source_url(vintage: int, county_code3: str) -> str:
    """The exact query, minus `key=...` -- used for manifest.url and
    SOURCE_URL.txt, so the API key is never persisted anywhere."""
    return f"{_census_base_url(vintage)}?{urlencode(_query_params(county_code3))}"


def _sanitize(message: str, key: str) -> str:
    return message.replace(key, "REDACTED") if key else message


def _fetch(vintage: int, county_code3: str, key: str) -> httpx.Response:
    params = dict(_query_params(county_code3), key=key)
    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(_census_base_url(vintage), params=params)
        resp.raise_for_status()
        return resp
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Census API vintage={vintage} county={county_code3} failed: "
            f"{_sanitize(str(exc), key)}"
        ) from None
    except httpx.RequestError as exc:
        raise RuntimeError(
            f"Census API vintage={vintage} county={county_code3} request error: "
            f"{_sanitize(str(exc), key)}"
        ) from None


def _valid_payload(resp: httpx.Response) -> list[list[str]] | None:
    """Parse and sanity-check the response body. Returns the parsed
    [[header], [row], ...] list if it carries every requested variable,
    else None -- never raises here, since a bad key or unavailable
    vintage can come back as an HTML page with a 200 status."""
    try:
        data = resp.json()
    except ValueError:
        return None
    if not isinstance(data, list) or len(data) < 1:
        return None
    header = data[0]
    if not isinstance(header, list) or not set(VARIABLES).issubset(set(header)):
        return None
    return data


def probe_vintage(key: str) -> tuple[int, dict[str, httpx.Response]]:
    """Try each vintage in VINTAGES order; the first vintage for which
    EVERY county's response is a valid ACS payload wins. Returns that
    vintage plus its per-county responses (so the caller need not
    re-fetch)."""
    last_error: Exception | None = None
    for vintage in VINTAGES:
        responses: dict[str, httpx.Response] = {}
        ok = True
        for county_fips, county_code3 in COUNTIES.items():
            try:
                resp = _fetch(vintage, county_code3, key)
            except RuntimeError as exc:
                last_error = exc
                ok = False
                break
            if _valid_payload(resp) is None:
                last_error = RuntimeError(
                    f"vintage={vintage} county={county_fips}: response was not a valid ACS5 payload"
                )
                ok = False
                break
            responses[county_fips] = resp
        if ok:
            return vintage, responses
    raise RuntimeError(f"no working ACS 5-year vintage among {VINTAGES}: {last_error}")


# ---------------------------------------------------------------------------
# Cleaning: Census annotations (negative sentinels) and missing values are
# never invented into a count -- see module docstring.
# ---------------------------------------------------------------------------


def _clean_count(raw: Any) -> tuple[int | None, str | None]:
    """(value, reason). reason is None only when `raw` cleanly parses to a
    non-negative int."""
    if raw is None:
        return None, "census_null"
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None, f"census_unparseable_{raw!r}"
    if n < 0:
        return None, f"census_annotation_{n}"
    return n, None


def _sum_components(row_by_var: dict[str, str], var_names: tuple[str, ...]) -> tuple[int | None, str | None]:
    """Sum every named variable's cleaned count. If ANY component is
    absent, the WHOLE sum is None with that component's reason -- never a
    partial sum."""
    total = 0
    for var in var_names:
        value, reason = _clean_count(row_by_var.get(var))
        if reason is not None:
            return None, f"{var}_{reason}"
        total += value
    return total, None


def rows_from_response(data: list[list[str]], county_fips: str) -> list[dict[str, Any]]:
    """[[header], [row], ...] -> a list of core.acs_bg row dicts (raw
    counts only -- no shares; see module docstring)."""
    header = data[0]
    idx = {name: i for i, name in enumerate(header)}
    for col in GEO_COLS:
        if col not in idx:
            raise ValueError(f"ACS response header missing expected geography column {col!r}: {header!r}")

    out: list[dict[str, Any]] = []
    for raw_row in data[1:]:
        row_by_var = {name: raw_row[idx[name]] for name in VARIABLES}
        geoid = "".join(raw_row[idx[col]] for col in GEO_COLS)

        pop_total, _pop_total_reason = _clean_count(row_by_var["B01001_001E"])
        pop_65_plus, pop_65_plus_reason = _sum_components(row_by_var, AGE65_VARS)
        housing_units_total, _housing_reason = _clean_count(row_by_var["B25040_001E"])
        heating_electric, heating_electric_reason = _clean_count(row_by_var["B25040_004E"])

        out.append(
            {
                "geoid": geoid,
                "county_fips": county_fips,
                "pop_total": pop_total,
                "pop_65_plus": pop_65_plus,
                "pop_65_plus_null_reason": pop_65_plus_reason,
                "housing_units_total": housing_units_total,
                "heating_electric": heating_electric,
                "heating_electric_null_reason": heating_electric_reason,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Manifest: reuse an existing row for the same (source, sha256); otherwise
# write the raw file, upload it unchanged, and insert.
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


def _ensure_manifest(
    vintage: int, county_fips: str, resp: httpx.Response, retrieved_at: datetime, runner: Runner
) -> dict[str, Any]:
    content = resp.content
    sha256 = hashlib.sha256(content).hexdigest()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest_path = RAW_DIR / f"{COUNTY_FILE_NAMES[county_fips]}.json"
    dest_path.write_bytes(content)

    url = source_url(vintage, COUNTIES[county_fips])
    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "sha256": sha256}

    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".json")
    storage.upload_raw(content, key, content_type="application/json")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=url,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=len(content),
            rows=len(resp.json()) - 1,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "sha256": sha256}


def _write_sidecars(retrieved_at: datetime, vintage: int, manifests: dict[str, dict[str, Any]]) -> None:
    url_lines = []
    sha_lines = []
    for county_fips, county_code3 in COUNTIES.items():
        fname = f"{COUNTY_FILE_NAMES[county_fips]}.json"
        url_lines.append(source_url(vintage, county_code3))
        sha_lines.append(f"{manifests[county_fips]['sha256']}  {fname}")
    (RAW_DIR / "SOURCE_URL.txt").write_text("\n".join(url_lines) + "\n")
    (RAW_DIR / "retrieved_at.txt").write_text(retrieved_at.isoformat().replace("+00:00", "Z") + "\n")
    (RAW_DIR / "SHA256SUMS").write_text("\n".join(sha_lines) + "\n")


# ---------------------------------------------------------------------------
# Load core.acs_bg
# ---------------------------------------------------------------------------


def _insert_batch(cur, batch: list[dict[str, Any]], manifest_id: str) -> None:
    """One multi-row INSERT per chunk (not executemany) -- see
    sources/tiger_bg.py's `_insert_batch` for why (pipeline-mode SSL
    errors against the session pooler with executemany)."""
    row_sql = "(%s, %s, %s, %s, %s, %s, %s, %s, %s)"
    values_sql = ", ".join(row_sql for _ in batch)
    params: list[Any] = []
    for r in batch:
        params.extend(
            [
                r["geoid"],
                r["county_fips"],
                r["pop_total"],
                r["pop_65_plus"],
                r["pop_65_plus_null_reason"],
                r["housing_units_total"],
                r["heating_electric"],
                r["heating_electric_null_reason"],
                manifest_id,
            ]
        )
    cur.execute(
        f"""
        insert into core.acs_bg
            (geoid, county_fips, pop_total, pop_65_plus, pop_65_plus_null_reason,
             housing_units_total, heating_electric, heating_electric_null_reason, source_id)
        values {values_sql}
        on conflict (geoid) do update set
            county_fips = excluded.county_fips,
            pop_total = excluded.pop_total,
            pop_65_plus = excluded.pop_65_plus,
            pop_65_plus_null_reason = excluded.pop_65_plus_null_reason,
            housing_units_total = excluded.housing_units_total,
            heating_electric = excluded.heating_electric,
            heating_electric_null_reason = excluded.heating_electric_null_reason,
            source_id = excluded.source_id
        """,
        params,
    )


def load_core(conn, manifest_id: str, rows: list[dict[str, Any]]) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), INSERT_CHUNK):
            batch = rows[i : i + INSERT_CHUNK]
            _insert_batch(cur, batch, manifest_id)
            loaded += len(batch)
    return loaded


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    key = config.require_env("CENSUS_API_KEY")
    vintage, responses = probe_vintage(key)
    retrieved_at = datetime.now(timezone.utc)

    manifests: dict[str, dict[str, Any]] = {
        county_fips: _ensure_manifest(vintage, county_fips, responses[county_fips], retrieved_at, runner)
        for county_fips in COUNTIES
    }
    _write_sidecars(retrieved_at, vintage, manifests)

    for county_fips in COUNTIES:
        data = _valid_payload(responses[county_fips])
        assert data is not None  # already validated by probe_vintage
        rows = rows_from_response(data, county_fips)
        manifest_id = manifests[county_fips]["id"]

        with db.connect(pooled=False) as conn:
            run_id = runs.start(conn, source=SOURCE, runner=runner, cursor={"vintage": vintage, "county_fips": county_fips})
            with conn.cursor() as cur:
                cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

        try:
            with db.connect(pooled=False) as conn:
                loaded = load_core(conn, manifest_id, rows)
            with db.connect(pooled=False) as conn:
                runs.finish(
                    conn, run_id, status="success",
                    rows_in=len(rows), rows_loaded=loaded, filter_drops={},
                    cursor={"vintage": vintage, "county_fips": county_fips},
                )
        except Exception as exc:
            with db.connect(pooled=False) as conn:
                runs.finish(conn, run_id, status="failed", error=str(exc), cursor={"vintage": vintage, "county_fips": county_fips})
            raise
