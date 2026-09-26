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
from enum import Enum
from typing import Annotated, Any, Callable, Literal

import httpx
import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from pipelines.core import config, db, runs

SOURCE = "home_summaries"
PROMPT_VERSION = 4
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


class FailureMode(str, Enum):
    """Every way a generated briefing can be rejected. Jev picks one of the
    first seven; the last three come from our own typed checks."""

    OK = "ok"
    CUT_OFF = "cut_off"
    UNGROUNDED = "ungrounded"
    WRONG_VOICE = "wrong_voice"
    HOUSEHOLD_OVERCLAIM = "household_overclaim"
    FORMATTING = "formatting"
    OFF_TASK = "off_task"
    SCHEMA_INVALID = "schema_invalid"
    JUDGE_UNAVAILABLE = "judge_unavailable"
    GEMINI_ERROR = "gemini_error"


JEV_FAILURE_MODES: dict[FailureMode, str] = {
    FailureMode.OK: "Complete, grounded in the facts, third person about this home, plain prose",
    FailureMode.CUT_OFF: "Ends mid-sentence or is clearly unfinished",
    FailureMode.UNGROUNDED: "States a number or claim not supported by the facts",
    FailureMode.WRONG_VOICE: "Addresses the homeowner as you/your instead of briefing the rep about this home",
    FailureMode.HOUSEHOLD_OVERCLAIM: "Presents a neighborhood (block group or ZIP) figure as a trait of this specific household",
    FailureMode.FORMATTING: "Contains headings, lists, markdown, or drafting notes",
    FailureMode.OFF_TASK: "Not a briefing about why this home ranks for outreach",
}


_SENTENCE = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=20, max_length=320, pattern=r"^[^\n*#`]+[.!?]$"),
]


class Briefing(BaseModel):
    """The response template Gemini fills (structured output). Each field
    is one complete plain sentence; anything else fails validation."""

    model_config = ConfigDict(extra="forbid")

    lead_reason: _SENTENCE
    supporting_reason: _SENTENCE
    neighborhood_context: _SENTENCE

    def text(self) -> str:
        return " ".join([self.lead_reason, self.supporting_reason, self.neighborhood_context])


class Verdict(BaseModel):
    """Jev's typed answer for one briefing."""

    mode: FailureMode
    confidence: float = Field(ge=0.0, le=1.0)
    judge_model: str


class GenerationFailed(Exception):
    def __init__(self, mode: FailureMode, detail: str = "") -> None:
        super().__init__(f"{mode.value}: {detail}")
        self.mode = mode


PROMPT_INSTRUCTIONS = (
    "Fill in a short briefing for a Base Power outreach rep about the home described in "
    "the facts: why it ranks well for a home-battery conversation. Refer to it as \"this "
    "home\" (third person; never \"you\" or \"your\"). Facts marked as block-group or ZIP "
    "figures describe the neighborhood: say \"in this neighborhood\", never that this "
    "household has that trait. Do not present being outside a flood zone as a reason for "
    "outreach. Use ONLY the facts: no invented numbers, names or details, and no dollar "
    "amounts. Each field is exactly one complete plain sentence.\n"
)

# Gemini's responseSchema, derived from the Briefing field names.
RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "lead_reason": {"type": "STRING", "description": "The strongest fact about this home, one sentence."},
        "supporting_reason": {"type": "STRING", "description": "The next strongest fact, one sentence."},
        "neighborhood_context": {"type": "STRING", "description": "One sentence of neighborhood context from block-group or ZIP facts."},
    },
    "required": list(Briefing.model_fields),
    "propertyOrdering": list(Briefing.model_fields),
}


def call_gemini(
    facts_text: str,
    *,
    api_key: str,
    model: str,
    feedback: FailureMode | None = None,
    timeout: float = GEMINI_TIMEOUT_S,
) -> Briefing:
    """One Gemini call that must return a valid Briefing. Raises
    GenerationFailed with a typed mode otherwise: CUT_OFF (did not finish
    or invalid JSON), SCHEMA_INVALID (JSON that fails Briefing), or
    GEMINI_ERROR (transport). `feedback` names the previous attempt's
    failure mode so the retry can correct it."""
    url = GEMINI_ENDPOINT.format(model=model)
    prompt = PROMPT_INSTRUCTIONS
    if feedback is not None:
        prompt += f"The previous attempt was rejected as '{feedback.value}': {JEV_FAILURE_MODES.get(feedback, feedback.value)}. Fix that.\n"
    body = {
        "contents": [{"parts": [{"text": prompt + "Facts:\n" + facts_text}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 400,
            "thinkingConfig": {"thinkingBudget": 0},
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    for attempt in range(GEMINI_MAX_RETRIES):
        try:
            resp = httpx.post(url, params={"key": api_key}, json=body, timeout=timeout)
        except httpx.HTTPError as exc:
            raise GenerationFailed(FailureMode.GEMINI_ERROR, type(exc).__name__) from exc
        if resp.status_code == 429:
            time.sleep(min(2 ** attempt, 8))
            continue
        if resp.status_code >= 400:
            raise GenerationFailed(FailureMode.GEMINI_ERROR, f"HTTP {resp.status_code}")
        cand = resp.json()["candidates"][0]
        if cand.get("finishReason") not in (None, "STOP"):
            raise GenerationFailed(FailureMode.CUT_OFF, str(cand.get("finishReason")))
        raw = "".join(p["text"] for p in cand.get("content", {}).get("parts", []) if p.get("text") and not p.get("thought"))
        try:
            return Briefing.model_validate_json(raw)
        except ValidationError as exc:
            # Unparseable JSON means the object was cut off; parseable-but-invalid means it broke the template.
            mode = FailureMode.CUT_OFF if any(e["type"] == "json_invalid" for e in exc.errors()) else FailureMode.SCHEMA_INVALID
            raise GenerationFailed(mode, str(exc.errors()[0].get("msg"))) from exc
    raise GenerationFailed(FailureMode.GEMINI_ERROR, "rate limited")


# ---------------------------------------------------------------------------
# Judge: TypeSafe Jev returns a typed failure mode for each candidate.
# ---------------------------------------------------------------------------

JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
JEV_OK_MIN_CONFIDENCE = 0.5  # OK confidence = 1 - worst failure probability
MAX_ATTEMPTS = 3


def jev_api_key() -> str:
    return _require_env("TYPESAFE_AI_JEV_API_KEY")


# One yes/no (Noul) question per failure mode, each with explicit meanings
# for yes and no. A single forced Choice let "ok" lose to loosely worded
# failure options (310 of 330 correct briefings judged household_overclaim);
# separate Nouls score each failure independently (measured on real replies:
# correct briefing <= 0.07 on every mode; real overclaim 0.96; real cut-off 0.97).
JEV_FAILURE_THRESHOLD = 0.5

JEV_NOULS: dict[FailureMode, dict[str, Any]] = {
    FailureMode.CUT_OFF: {
        "instructions": "Is `briefing` unfinished, i.e. does it stop mid-sentence or end without a complete final sentence?",
        "criteria": {"true": "Stops mid-sentence or trails off", "false": "Every sentence is complete"},
    },
    FailureMode.UNGROUNDED: {
        "instructions": "Does `briefing` state any number or claim that is not supported by `facts`?",
        "criteria": {"true": "Contains a number or claim absent from or contradicting `facts`", "false": "Every number and claim appears in `facts`"},
    },
    FailureMode.WRONG_VOICE: {
        "instructions": "Does `briefing` address the homeowner directly as 'you' or 'your'?",
        "criteria": {"true": "Uses you/your toward the homeowner", "false": "Talks about 'this home' or 'this neighborhood' in the third person"},
    },
    FailureMode.HOUSEHOLD_OVERCLAIM: {
        "instructions": "Some `facts` are neighborhood figures (block-group or ZIP shares). Does `briefing` claim that THIS specific household or homeowner has one of those traits?",
        "criteria": {
            "true": "States a neighborhood share as a fact about this household, e.g. 'the homeowner is over 65' or 'this home heats with electricity'",
            "false": "Neighborhood figures are attributed to the neighborhood or area, e.g. 'in this neighborhood, 25.6% are 65+'",
        },
    },
    FailureMode.FORMATTING: {
        "instructions": "Does `briefing` contain headings, bullet lists, markdown symbols, or drafting notes?",
        "criteria": {"true": "Has headings, lists, markdown or drafting notes", "false": "Plain prose only"},
    },
    FailureMode.OFF_TASK: {
        "instructions": "Is `briefing` about something other than why this home ranks for a home-battery outreach conversation?",
        "criteria": {"true": "Off topic", "false": "Explains why this home ranks for outreach"},
    },
}


def verdict_from_nouls(nouls: dict[FailureMode, float], judge_model: str) -> Verdict:
    """Pure: the most likely failure at or above the threshold, else OK.
    Confidence is that failure's probability, or 1 - the largest failure
    probability for OK."""
    worst_mode, worst_p = max(nouls.items(), key=lambda kv: kv[1])
    if worst_p >= JEV_FAILURE_THRESHOLD:
        return Verdict(mode=worst_mode, confidence=worst_p, judge_model=judge_model)
    return Verdict(mode=FailureMode.OK, confidence=1.0 - worst_p, judge_model=judge_model)


def judge_briefing(briefing: Briefing, facts_text: str, *, api_key: str, timeout: float = 30.0) -> Verdict:
    """One Jev call asking every failure-mode Noul at once (speculative
    fan-out); returns a typed Verdict. Raises GenerationFailed(JUDGE_UNAVAILABLE)
    on any transport or shape problem."""
    try:
        resp = httpx.post(
            JEV_ENDPOINT,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": JEV_MODEL,
                "state": {"facts": facts_text, "briefing": briefing.text()},
                "questions": {m.value: {"type": "noul", **q} for m, q in JEV_NOULS.items()},
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        nouls = {m: float(data["answers"][m.value]["noul"]) for m in JEV_NOULS}
        return verdict_from_nouls(nouls, data.get("model", JEV_MODEL))
    except (httpx.HTTPError, KeyError, ValueError, ValidationError) as exc:
        raise GenerationFailed(FailureMode.JUDGE_UNAVAILABLE, type(exc).__name__) from exc


def generate_briefing(
    facts_text: str,
    *,
    generate: Callable[[FailureMode | None], Briefing],
    judge: Callable[[Briefing], Verdict],
    max_attempts: int = MAX_ATTEMPTS,
) -> tuple[Briefing | None, Verdict | None, FailureMode, int]:
    """The retry policy, independent of any network call so it is tested
    deterministically with typed inputs. Each attempt: generate a typed
    Briefing, apply the number guard, then Jev. Retries feed the last
    failure mode back into generation. Returns (accepted briefing or None,
    last verdict, last failure mode, attempts used)."""
    feedback: FailureMode | None = None
    last_verdict: Verdict | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            briefing = generate(feedback)
        except GenerationFailed as exc:
            feedback = exc.mode
            continue
        if not grounding_guard_passes(briefing.text(), facts_text):
            feedback = FailureMode.UNGROUNDED
            continue
        try:
            last_verdict = judge(briefing)
        except GenerationFailed as exc:
            return None, None, exc.mode, attempt  # never accept unjudged text
        if last_verdict.mode is FailureMode.OK and last_verdict.confidence >= JEV_OK_MIN_CONFIDENCE:
            return briefing, last_verdict, FailureMode.OK, attempt
        feedback = last_verdict.mode
    return None, last_verdict, feedback or FailureMode.GEMINI_ERROR, max_attempts


# ---------------------------------------------------------------------------
# Per-home job
# ---------------------------------------------------------------------------


def process_one(prop_id: str, *, api_key: str, model: str, jev_key: str | None = None) -> dict[str, Any]:
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

        briefing, verdict, final_mode, attempts = generate_briefing(
            facts_text,
            generate=lambda fb: call_gemini(facts_text, api_key=api_key, model=model, feedback=fb),
            judge=lambda b: judge_briefing(b, facts_text, api_key=jev_key or jev_api_key()),
        )
        is_template = briefing is None
        guard_failed = is_template
        used_model: str | None = None if is_template else model
        summary = build_template_sentence(breakdown, ctx) if briefing is None else briefing.text()

        with conn.cursor() as cur:
            cur.execute(
                """
                insert into core.home_summary
                    (prop_id, summary, is_template, guard_failed, model, prompt_version,
                     facts_hash, source_ids, judge_verdict, judge_confidence, judge_model,
                     attempts, briefing, generated_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                on conflict (prop_id) do update set
                    summary = excluded.summary,
                    is_template = excluded.is_template,
                    guard_failed = excluded.guard_failed,
                    model = excluded.model,
                    prompt_version = excluded.prompt_version,
                    facts_hash = excluded.facts_hash,
                    judge_verdict = excluded.judge_verdict,
                    judge_confidence = excluded.judge_confidence,
                    judge_model = excluded.judge_model,
                    attempts = excluded.attempts,
                    briefing = excluded.briefing,
                    source_ids = excluded.source_ids,
                    generated_at = excluded.generated_at
                """,
                (
                    prop_id, summary, is_template, guard_failed, used_model, PROMPT_VERSION,
                    this_hash, ctx.source_ids or [],
                    final_mode.value,
                    verdict.confidence if verdict else None,
                    verdict.judge_model if verdict else None,
                    attempts,
                    Jsonb(briefing.model_dump()) if briefing else None,
                ),
            )
    return {"prop_id": prop_id, "skipped": False, "is_template": is_template, "guard_failed": guard_failed, "mode": final_mode.value, "attempts": attempts}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    api_key = gemini_api_key()
    model = brief_model()
    jev_key = jev_api_key()

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
            futures = {pool.submit(process_one, pid, api_key=api_key, model=model, jev_key=jev_key): pid for pid in todo}
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
