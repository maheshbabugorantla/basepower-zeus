"""Pre-generate "why this home" summaries for GTM (M2-W5, github #65).

Security decision (scope change): the public web app never calls Gemini —
a public route that could trigger an LLM call lets anyone burn credits.
This module is the ONLY place in the codebase that calls Gemini. It runs
CLI/cron-side only (GEMINI_API_KEY + BRIEF_MODEL are never read by web/),
reads api.home_score_breakdown(prop_id, EQUAL_WEIGHTS) — the same
deterministic terms api.top_homes_weighted uses — plus distributor name/
SAIDI and block-group context already in core.mv_home_signals, and
upserts a 2-3 sentence summary into core.home_summary (0207_score_explain.
sql). The web app only ever does a primary-key read (api.home_summary).

Grounding guard: every number in the Gemini reply must appear (after
normalizing commas/decimals) in the input facts text. If the guard fails,
or the call errors or exceeds GEMINI_TIMEOUT_S, the row is stored with
the deterministic template sentence instead (built from the breakdown's
top 2 contributions) and guard_failed/is_template=true — never an
ungrounded LLM reply, and never a synthetic fact.

Real-data rule: this module invents no rows and writes no
ops.source_manifest entry (like pipelines/sources/refresh_scores.py, it
derives entirely from already-manifested data — core.mv_home_signals,
itself built from M1/M2 sources — and forwards that provenance via
core.home_summary.source_ids). A template sentence is built only from
real facts already in the breakdown, never a placeholder.

Selection for THIS ticket's run (not the full backfill): the top 500
gate-passed Travis (county_fips 48453) homes by equal-weight score, plus
the 3 real homes pipelines/tests/test_home_summaries.py exercises (a
subset of that same top-500 set today, listed explicitly so a future
change to the ranking can't silently drop test coverage). `backfill=True`
processes every gate-passed Travis home instead — intentionally NOT run
by this ticket; see the module docstring's "Full backfill" note below for
the command.

Full backfill (NOT run by this ticket — ~real count of gate-passed Travis
homes, each one Gemini call; run only when asked):
    python -m pipelines.run home_summaries --backfill
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Literal

import httpx
import psycopg

from pipelines.core import config, db, runs

SOURCE = "home_summaries"
PROMPT_VERSION = 1
TRAVIS_COUNTY_FIPS = "48453"
TOP_N = 500
# The 3 real homes pipelines/tests/test_home_summaries.py's live-DB tests
# exercise (verified gate-passed Travis homes, seen in api.top_homes_weighted
# at equal weights during this ticket's build) — unioned into every
# non-backfill run so the tested rows always exist in core.home_summary.
TEST_PROP_IDS: tuple[str, ...] = ("572532", "572533", "572534")

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GEMINI_TIMEOUT_S = 8.0
GEMINI_MAX_RETRIES = 3
CONCURRENCY = 5

EQUAL_WEIGHTS: dict[str, float] = {
    "outage": 1, "flood": 1, "empower": 1, "age65": 1, "electric_heat": 1, "backup_intent": 1,
}
EQUAL_WEIGHTS_JSON = json.dumps(EQUAL_WEIGHTS)

Runner = Literal["cron", "cli"]

# ---------------------------------------------------------------------------
# Env access (mirrors pipelines.core.config.require_env; kept local since
# this ticket owns only pipelines/sources/home_summaries.py, not config.py)
# ---------------------------------------------------------------------------


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required environment variable {name} is not set")
    return value


def gemini_api_key() -> str:
    return _require_env("GEMINI_API_KEY")


def brief_model() -> str:
    return _require_env("BRIEF_MODEL")


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------


def select_target_prop_ids(conn: psycopg.Connection, *, backfill: bool) -> list[str]:
    """Gate-passed Travis homes to (re)generate a summary for. Same scoring
    terms/weight normalisation as api.top_homes_weighted (0201_m2.sql),
    computed inline against core.mv_home_signals rather than through that
    function (which hard-limits to 50 rows) — equal weights, no LIMIT for a
    backfill, LIMIT TOP_N otherwise, always unioned with TEST_PROP_IDS."""
    limit_clause = "" if backfill else f"limit {TOP_N}"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            with narrow as (
                select
                    prop_id,
                    distributor_saidi_pctile, flood_pctile, empower_pctile,
                    acs_65_pctile, acs_heat_pctile, backup_intent_pctile
                from core.mv_home_signals
                where gate_reason is null and county_fips = %(county)s
            ),
            scored as (
                select
                    prop_id,
                    (
                        case when distributor_saidi_pctile is not null then distributor_saidi_pctile else 0 end
                        + case when flood_pctile is not null then 1 - flood_pctile else 0 end
                        + case when empower_pctile is not null then empower_pctile else 0 end
                        + case when acs_65_pctile is not null then acs_65_pctile else 0 end
                        + case when acs_heat_pctile is not null then acs_heat_pctile else 0 end
                        + case when backup_intent_pctile is not null then backup_intent_pctile else 0 end
                    ) as weighted_sum,
                    (
                        case when distributor_saidi_pctile is not null then 1 else 0 end
                        + case when flood_pctile is not null then 1 else 0 end
                        + case when empower_pctile is not null then 1 else 0 end
                        + case when acs_65_pctile is not null then 1 else 0 end
                        + case when acs_heat_pctile is not null then 1 else 0 end
                        + case when backup_intent_pctile is not null then 1 else 0 end
                    ) as weight_sum
                from narrow
            ),
            ranked as (
                select prop_id, (weighted_sum / weight_sum)::numeric as final_score
                from scored
                where weight_sum > 0
            )
            select prop_id from ranked order by final_score desc, prop_id {limit_clause}
            """,
            {"county": TRAVIS_COUNTY_FIPS},
        )
        ids = [r[0] for r in cur.fetchall()]
    return sorted(set(ids) | set(TEST_PROP_IDS))


# ---------------------------------------------------------------------------
# Facts: api.home_score_breakdown + distributor/block-group context, all
# formatted into one deterministic facts_text — the ONLY input Gemini sees,
# and the exact text the grounding guard checks numbers against.
# ---------------------------------------------------------------------------


class BreakdownRow:
    __slots__ = ("key", "label", "raw_value", "raw_unit", "percentile", "contribution", "available", "null_reason")

    def __init__(self, row: tuple[Any, ...]) -> None:
        (self.key, self.label, self.raw_value, self.raw_unit, self.percentile,
         _weight, self.contribution, self.available, self.null_reason) = row


def fetch_breakdown(conn: psycopg.Connection, prop_id: str) -> list[BreakdownRow]:
    with conn.cursor() as cur:
        cur.execute(
            "select key, label, raw_value, raw_unit, percentile, weight, contribution, available, null_reason "
            "from api.home_score_breakdown(%s, %s::jsonb)",
            (prop_id, EQUAL_WEIGHTS_JSON),
        )
        return [BreakdownRow(r) for r in cur.fetchall()]


class HomeContext:
    __slots__ = ("prop_id", "distributor_name", "distributor_saidi_year", "block_group_geoid", "source_ids")

    def __init__(self, row: tuple[Any, ...]) -> None:
        (self.prop_id, self.distributor_name, self.distributor_saidi_year,
         self.block_group_geoid, self.source_ids) = row


def fetch_context(conn: psycopg.Connection, prop_id: str) -> HomeContext | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            select prop_id, distributor_name, distributor_saidi_year,
                   block_group_geoid, source_ids
            from core.mv_home_signals
            where prop_id = %s
            """,
            (prop_id,),
        )
        row = cur.fetchone()
    return HomeContext(row) if row else None


def _fmt(value: Any, decimals: int) -> str:
    return f"{float(value):.{decimals}f}"


def _ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _percentile_label(pctile: Any) -> str:
    return f"{_ordinal(round(float(pctile) * 100))} percentile"


def build_fact_line(row: BreakdownRow, ctx: HomeContext) -> str | None:
    """One plain-language, fully-grounded sentence fragment per AVAILABLE
    signal — the exact wording (raw value scale, unit) already shown on
    the home page (web/app/home/[prop_id]/page.tsx) and the ranking table,
    so a rep reading the summary never sees a number phrased differently
    from the rest of the app. Returns None for an unavailable signal —
    never a placeholder line."""
    if not row.available or row.raw_value is None:
        return None
    if row.key == "outage":
        distributor = ctx.distributor_name or "This distributor"
        year = f" in {ctx.distributor_saidi_year}" if ctx.distributor_saidi_year else ""
        return (
            f"Outage exposure: {distributor}'s customers averaged {_fmt(row.raw_value, 1)} "
            f"minutes without power{year} (SAIDI, incl. major events); {_percentile_label(row.percentile)} "
            f"among scored Travis homes."
        )
    if row.key == "flood":
        inside = "Inside" if float(row.raw_value) == 1 else "Outside"
        return (
            f"Installability: {inside} a FEMA Special Flood Hazard Area; "
            f"{_percentile_label(row.percentile)} for being outside a flood zone."
        )
    if row.key == "empower":
        return (
            f"Medical need: {_fmt(row.raw_value, 1)} power-dependent Medicare devices per 1,000 "
            f"Medicare beneficiaries in this ZIP; {_percentile_label(row.percentile)}."
        )
    if row.key == "age65":
        return (
            f"Age 65+: {_fmt(row.raw_value, 1)}% of this block group's population is 65+ "
            f"(ACS, same for every home in the block group); {_percentile_label(row.percentile)}."
        )
    if row.key == "electric_heat":
        return (
            f"Electric heat: {_fmt(row.raw_value, 1)}% of housing units in this block group heat "
            f"with electricity (ACS, same for every home in the block group); {_percentile_label(row.percentile)}."
        )
    if row.key == "backup_intent":
        return (
            f"Backup intent: {_fmt(row.raw_value, 2)} battery/generator permits per 1,000 gated "
            f"homes in this block group (36 months, same for every home in the block group); "
            f"{_percentile_label(row.percentile)}."
        )
    return None


def build_facts_text(breakdown: list[BreakdownRow], ctx: HomeContext) -> str:
    lines = [build_fact_line(r, ctx) for r in breakdown]
    lines = [ln for ln in lines if ln is not None]
    lines.append(f"Location: Travis County, block group {ctx.block_group_geoid}.")
    return "\n".join(f"- {ln}" for ln in lines)


def facts_hash(facts_text: str) -> str:
    return hashlib.sha256(facts_text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Grounding guard — pure, no network. Every number the reply uses must
# appear (after normalizing commas/trailing zeros) somewhere in the facts
# text. This also naturally allows constants embedded in unit phrasing
# (e.g. "per 1,000") since they are extracted from the same facts text.
# ---------------------------------------------------------------------------

_NUMBER_RE = re.compile(r"-?\d[\d,]*\.?\d*")


def _normalize_number(token: str) -> str:
    token = token.replace(",", "").rstrip(".")
    try:
        value = float(token)
    except ValueError:
        return token
    if value == int(value):
        return str(int(value))
    return f"{value:.1f}"


def extract_numbers(text: str) -> set[str]:
    return {_normalize_number(m) for m in _NUMBER_RE.findall(text)}


def grounding_guard_passes(reply: str, facts_text: str) -> bool:
    """True iff every number in `reply` (normalized) also appears
    (normalized) in `facts_text`. An empty reply trivially passes (there
    is nothing ungrounded to reject) but is rejected by the caller for a
    different reason (no usable content)."""
    reply_numbers = extract_numbers(reply)
    if not reply_numbers:
        return True
    fact_numbers = extract_numbers(facts_text)
    return reply_numbers.issubset(fact_numbers)


# ---------------------------------------------------------------------------
# Deterministic template — no LLM, built only from the breakdown's top 2
# contributions (by contribution desc, ties broken by key for stability).
# ---------------------------------------------------------------------------


def build_template_sentence(breakdown: list[BreakdownRow], ctx: HomeContext) -> str:
    """Built ONLY from the top 2 available contributions, reusing
    build_fact_line's exact phrasing for each (never a separately
    formatted number) — so the template is grounded in the facts text by
    construction, not by coincidence. `ctx` is required because
    build_fact_line needs it for the outage signal's distributor name."""
    available = [r for r in breakdown if r.available and r.contribution is not None]
    top2 = sorted(available, key=lambda r: (-float(r.contribution), r.key))[:2]
    lines = [build_fact_line(r, ctx) for r in top2]
    lines = [ln for ln in lines if ln]
    if not lines:
        return "No signal has usable data for this home yet — every score input is currently marked not loaded or not available."
    if len(lines) == 1:
        return f"This home's strongest scored signal: {lines[0]}"
    return f"This home's two strongest scored signals: {lines[0]} {lines[1]}"


# ---------------------------------------------------------------------------
# Gemini call
# ---------------------------------------------------------------------------


PROMPT_INSTRUCTIONS = (
    "You are writing 2-3 short sentences a Base Power sales rep could say out loud on a "
    "call, explaining why this specific home was flagged for outreach. Use ONLY the facts "
    "listed below — do not invent any number, name, or detail not listed. Never mention or "
    "estimate a dollar amount. Be plain and concrete, not salesy. Facts:\n"
)


def call_gemini(facts_text: str, *, api_key: str, model: str, timeout: float = GEMINI_TIMEOUT_S) -> str:
    url = GEMINI_ENDPOINT.format(model=model)
    body = {
        "contents": [{"parts": [{"text": PROMPT_INSTRUCTIONS + facts_text}]}],
        # thinkingBudget=0: gemini-3.x "thinking" models otherwise spend most
        # of maxOutputTokens on an internal, non-quotable thought trace before
        # any visible text — observed truncating a 2-3 sentence reply to a few
        # words at maxOutputTokens=220 (finishReason MAX_TOKENS, ~200 thought
        # tokens). This task needs no multi-step reasoning, so thinking is
        # disabled outright rather than raising the token budget.
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 300,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    last_exc: Exception | None = None
    for attempt in range(GEMINI_MAX_RETRIES):
        try:
            resp = httpx.post(url, params={"key": api_key}, json=body, timeout=timeout)
            if resp.status_code == 429:
                time.sleep(min(2 ** attempt, 8))
                continue
            resp.raise_for_status()
            data = resp.json()
            return data["candidates"][0]["content"]["parts"][0]["text"].strip()
        except Exception as exc:  # noqa: BLE001 — any failure falls back to the template
            last_exc = exc
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429:
                time.sleep(min(2 ** attempt, 8))
                continue
            break
    raise RuntimeError(f"Gemini call failed after retries: {last_exc}")


# ---------------------------------------------------------------------------
# Per-home job
# ---------------------------------------------------------------------------


def process_one(prop_id: str, *, api_key: str, model: str) -> dict[str, Any]:
    """Idempotent: skips (returns {"skipped": True}) if a stored row's
    facts_hash + prompt_version already match — never re-billed for an
    unchanged home. Otherwise generates (or falls back to the template)
    and upserts core.home_summary."""
    with db.connect(pooled=False) as conn:
        ctx = fetch_context(conn, prop_id)
        if ctx is None:
            return {"prop_id": prop_id, "skipped": True, "reason": "no_mv_home_signals_row"}
        breakdown = fetch_breakdown(conn, prop_id)
        facts_text = build_facts_text(breakdown, ctx)
        this_hash = facts_hash(facts_text)

        with conn.cursor() as cur:
            cur.execute(
                "select facts_hash, prompt_version from core.home_summary where prop_id = %s",
                (prop_id,),
            )
            existing = cur.fetchone()
        if existing is not None and existing[0] == this_hash and existing[1] == PROMPT_VERSION:
            return {"prop_id": prop_id, "skipped": True, "reason": "unchanged_facts_hash"}

        is_template = False
        guard_failed = False
        used_model: str | None = model
        try:
            reply = call_gemini(facts_text, api_key=api_key, model=model)
            if not reply or not grounding_guard_passes(reply, facts_text):
                is_template = True
                guard_failed = True
                summary = build_template_sentence(breakdown, ctx)
                used_model = None
            else:
                summary = reply
        except Exception:
            is_template = True
            summary = build_template_sentence(breakdown, ctx)
            used_model = None

        with conn.cursor() as cur:
            cur.execute(
                """
                insert into core.home_summary
                    (prop_id, summary, is_template, guard_failed, model, prompt_version,
                     facts_hash, source_ids, generated_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, now())
                on conflict (prop_id) do update set
                    summary = excluded.summary,
                    is_template = excluded.is_template,
                    guard_failed = excluded.guard_failed,
                    model = excluded.model,
                    prompt_version = excluded.prompt_version,
                    facts_hash = excluded.facts_hash,
                    source_ids = excluded.source_ids,
                    generated_at = excluded.generated_at
                """,
                (
                    prop_id, summary, is_template, guard_failed, used_model, PROMPT_VERSION,
                    this_hash, ctx.source_ids or [],
                ),
            )
    return {"prop_id": prop_id, "skipped": False, "is_template": is_template, "guard_failed": guard_failed}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    api_key = gemini_api_key()
    model = brief_model()

    with db.connect(pooled=False) as run_conn:
        target_ids = select_target_prop_ids(run_conn, backfill=backfill)

    already_done = set((cursor or {}).get("processed_prop_ids") or [])
    todo = [pid for pid in target_ids if pid not in already_done]

    with psycopg.connect(
        config.postgres_url_non_pooling(), prepare_threshold=None, autocommit=False
    ) as start_conn:
        run_id = runs.start(start_conn, source=SOURCE, runner=runner, cursor=cursor)

    rows_in = len(todo)
    processed: list[str] = []
    skipped_count = 0
    template_count = 0
    error: str | None = None
    try:
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futures = {pool.submit(process_one, pid, api_key=api_key, model=model): pid for pid in todo}
            for future in as_completed(futures):
                pid = futures[future]
                result = future.result()
                processed.append(pid)
                if result.get("skipped"):
                    skipped_count += 1
                elif result.get("is_template"):
                    template_count += 1
    except Exception as exc:
        error = str(exc)

    filter_drops = {"skipped_unchanged": skipped_count, "stored_as_template": template_count}
    with psycopg.connect(
        config.postgres_url_non_pooling(), prepare_threshold=None, autocommit=False
    ) as finish_conn:
        runs.finish(
            finish_conn,
            run_id,
            status="failed" if error else "success",
            rows_in=rows_in,
            rows_loaded=len(processed),
            filter_drops=filter_drops,
            cursor={"processed_prop_ids": sorted(already_done | set(processed))},
            error=error,
        )
    if error:
        raise RuntimeError(error)
