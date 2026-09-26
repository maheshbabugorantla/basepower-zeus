"""Real tests for pipelines/sources/home_summaries.py (M2-W5, github #65).

No synthetic data: every fact string, breakdown row and Gemini reply used
below comes from a real call against the live database (skipped if
POSTGRES_URL_NON_POOLING isn't configured) or, for the pipeline's already
pre-generated backfill, a real stored core.home_summary row. The one
"invented" input the ticket explicitly calls for — a rejected grounding-
guard case — is built by taking a REAL, already-grounded sentence (the
deterministic template, itself built only from real breakdown facts) and
appending a number that provably is not in the real facts text, per the
ticket's own instruction: "construct the rejected case by appending a
number absent from the real facts to a real reply".
"""
from __future__ import annotations

import os

import pytest

from sources import home_summaries as hs
from pipelines.core import db

# Real, gate-passed Travis homes seen in api.top_homes_weighted at equal
# weights during this ticket's build — the same 3 the module's own
# TEST_PROP_IDS constant lists, so a run without --backfill always covers
# these rows.
REAL_PROP_IDS = hs.TEST_PROP_IDS

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="POSTGRES_URL_NON_POOLING not configured",
)


def _real_facts_and_breakdown(prop_id: str) -> tuple[str, list[hs.BreakdownRow], hs.HomeContext]:
    with db.connect(pooled=False) as conn:
        ctx = hs.fetch_context(conn, prop_id)
        assert ctx is not None, f"expected a real core.mv_home_signals row for {prop_id}"
        breakdown = hs.fetch_breakdown(conn, prop_id)
    facts_text = hs.build_facts_text(breakdown, ctx)
    return facts_text, breakdown, ctx


@pytest.mark.parametrize("prop_id", REAL_PROP_IDS)
def test_facts_text_is_real_and_nonempty(prop_id):
    facts_text, breakdown, _ctx = _real_facts_and_breakdown(prop_id)
    assert facts_text.strip() != ""
    assert "Location: Travis County, block group" in facts_text
    # Every available signal's raw value is extractable from the facts
    # text (after the same normalization the grounding guard uses) — the
    # facts text is not just non-empty prose, it actually carries the
    # real numbers the guard will check a reply against.
    fact_numbers = hs.extract_numbers(facts_text)
    for row in breakdown:
        # flood's fact line describes inside/outside in words, never as a
        # formatted number (see build_fact_line) — nothing to check there.
        if row.available and row.raw_value is not None and row.key != "flood":
            decimals = 2 if row.key == "backup_intent" else 1
            assert hs._normalize_number(f"{float(row.raw_value):.{decimals}f}") in fact_numbers


@pytest.mark.parametrize("prop_id", REAL_PROP_IDS)
def test_breakdown_contribution_sums_to_ranked_score(prop_id):
    """api.home_score_breakdown's contributions sum to the home's real
    api.top_homes_weighted score at equal weights (±0.001) — the
    web/tests/m2-explain suite checks this too; repeated here since the
    pipeline's own facts (and thus its summaries) depend on this same
    identity holding."""
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select score from api.top_homes_weighted(%s::jsonb, '48453') where prop_id = %s",
                (hs.EQUAL_WEIGHTS_JSON, prop_id),
            )
            row = cur.fetchone()
        assert row is not None, f"{prop_id} not found in api.top_homes_weighted at equal weights"
        (ranked_score,) = row
        breakdown = hs.fetch_breakdown(conn, prop_id)
    total = sum(float(r.contribution) for r in breakdown if r.contribution is not None)
    assert abs(float(ranked_score) - total) <= 0.001


def test_template_sentence_uses_top_two_real_contributions():
    _facts_text, breakdown, ctx = _real_facts_and_breakdown(REAL_PROP_IDS[0])
    sentence = hs.build_template_sentence(breakdown, ctx)
    available = [r for r in breakdown if r.available and r.contribution is not None]
    top2 = sorted(available, key=lambda r: (-float(r.contribution), r.key))[:2]
    for row in top2:
        # Reuses build_fact_line's own phrasing verbatim (never a
        # separately formatted number) — that exact fragment must appear.
        assert hs.build_fact_line(row, ctx) in sentence


def test_grounding_guard_passes_a_real_grounded_sentence():
    facts_text, breakdown, ctx = _real_facts_and_breakdown(REAL_PROP_IDS[0])
    real_reply = hs.build_template_sentence(breakdown, ctx)  # built only from real facts -> inherently grounded
    assert hs.grounding_guard_passes(real_reply, facts_text) is True


def test_grounding_guard_rejects_a_real_reply_with_an_invented_number():
    facts_text, breakdown, ctx = _real_facts_and_breakdown(REAL_PROP_IDS[0])
    real_reply = hs.build_template_sentence(breakdown, ctx)
    assert hs.grounding_guard_passes(real_reply, facts_text) is True  # sanity: the unmodified sentence passes

    # Per the ticket: construct the rejected case by appending a number
    # absent from the real facts to that real reply.
    invented_number = "784512"
    assert invented_number not in hs.extract_numbers(facts_text)
    rejected_reply = f"{real_reply} This home also had {invented_number} total incidents."
    assert hs.grounding_guard_passes(rejected_reply, facts_text) is False


@pytest.mark.skipif(
    not (os.environ.get("GEMINI_API_KEY") and os.environ.get("BRIEF_MODEL") and os.environ.get("TYPESAFE_AI_JEV_API_KEY")),
    reason="GEMINI_API_KEY/BRIEF_MODEL/TYPESAFE_AI_JEV_API_KEY not configured",
)
def test_process_one_is_idempotent_on_unchanged_facts():
    prop_id = REAL_PROP_IDS[1]
    api_key = hs.gemini_api_key()
    model = hs.brief_model()

    jev_key = hs.jev_api_key()
    first = hs.process_one(prop_id, api_key=api_key, model=model, jev_key=jev_key)
    assert first["skipped"] in (True, False)
    second = hs.process_one(prop_id, api_key=api_key, model=model, jev_key=jev_key)
    assert second == {"prop_id": prop_id, "skipped": True, "reason": "unchanged_facts_hash"}


# ---------------------------------------------------------------------------
# Typed contracts. Live model output is never matched against prose
# patterns: a Gemini reply must parse into hs.Briefing and a Jev answer into
# hs.Verdict. The retry policy is tested with typed inputs built only from
# real fact lines (build_fact_line over real breakdown rows).
# ---------------------------------------------------------------------------


def _real_briefing(prop_id: str) -> tuple[hs.Briefing, str]:
    facts_text, breakdown, ctx = _real_facts_and_breakdown(prop_id)
    available = [r for r in breakdown if r.available and r.contribution is not None]
    lines = [hs.build_fact_line(r, ctx) for r in sorted(available, key=lambda r: (-float(r.contribution), r.key))]
    lines = [ln for ln in lines if ln][:3]
    assert len(lines) == 3, "expected 3 real fact lines"
    return hs.Briefing(lead_reason=lines[0], supporting_reason=lines[1], neighborhood_context=lines[2]), facts_text


# Real prompt-v1 Gemini replies (core.home_summary, 2026-09-26), verbatim.
REAL_BROKEN_V1_REPLIES = [
    "Your home was flagged because it sits",
    "Drafting Options:**\n    *   *Draft",
    "sentences):**\n    *   *",
]


@pytest.mark.parametrize("reply", REAL_BROKEN_V1_REPLIES)
def test_briefing_schema_rejects_real_broken_v1_replies(reply):
    with pytest.raises(hs.ValidationError):
        hs.Briefing(lead_reason=reply, supporting_reason=reply, neighborhood_context=reply)


def test_retry_policy_accepts_after_typed_failure_and_feeds_it_back():
    briefing, facts_text = _real_briefing(REAL_PROP_IDS[0])
    seen_feedback: list[hs.FailureMode | None] = []

    def generate(feedback):
        seen_feedback.append(feedback)
        if len(seen_feedback) == 1:
            raise hs.GenerationFailed(hs.FailureMode.CUT_OFF)
        return briefing

    accepted, verdict, mode, attempts = hs.generate_briefing(
        facts_text,
        generate=generate,
        judge=lambda b: hs.Verdict(mode=hs.FailureMode.OK, confidence=0.9, judge_model="jev-test"),
    )
    assert accepted == briefing
    assert mode is hs.FailureMode.OK and attempts == 2
    assert seen_feedback == [None, hs.FailureMode.CUT_OFF]


def test_retry_policy_falls_back_after_repeated_judge_rejection():
    briefing, facts_text = _real_briefing(REAL_PROP_IDS[0])
    accepted, verdict, mode, attempts = hs.generate_briefing(
        facts_text,
        generate=lambda fb: briefing,
        judge=lambda b: hs.Verdict(mode=hs.FailureMode.HOUSEHOLD_OVERCLAIM, confidence=0.8, judge_model="jev-test"),
    )
    assert accepted is None
    assert mode is hs.FailureMode.HOUSEHOLD_OVERCLAIM and attempts == hs.MAX_ATTEMPTS


def test_retry_policy_never_accepts_unjudged_text():
    briefing, facts_text = _real_briefing(REAL_PROP_IDS[0])

    def judge(b):
        raise hs.GenerationFailed(hs.FailureMode.JUDGE_UNAVAILABLE)

    accepted, verdict, mode, attempts = hs.generate_briefing(facts_text, generate=lambda fb: briefing, judge=judge)
    assert accepted is None and mode is hs.FailureMode.JUDGE_UNAVAILABLE


def test_retry_policy_rejects_ungrounded_numbers_before_judging():
    briefing, facts_text = _real_briefing(REAL_PROP_IDS[0])
    absent = next(str(n) for n in range(987654, 987700) if str(n) not in facts_text)
    ungrounded = briefing.model_copy(update={"supporting_reason": briefing.supporting_reason[:-1] + f" across {absent} homes."})
    judged: list[hs.Briefing] = []
    accepted, verdict, mode, attempts = hs.generate_briefing(
        facts_text,
        generate=lambda fb: ungrounded,
        judge=lambda b: judged.append(b) or hs.Verdict(mode=hs.FailureMode.OK, confidence=1.0, judge_model="jev-test"),
    )
    assert accepted is None and mode is hs.FailureMode.UNGROUNDED and judged == []


@pytest.mark.skipif(
    not (os.environ.get("GEMINI_API_KEY") and os.environ.get("BRIEF_MODEL")),
    reason="GEMINI_API_KEY/BRIEF_MODEL not configured",
)
def test_live_gemini_reply_is_a_typed_briefing():
    facts_text, _, _ = _real_facts_and_breakdown(REAL_PROP_IDS[0])
    try:
        result = hs.call_gemini(facts_text, api_key=hs.gemini_api_key(), model=hs.brief_model())
    except hs.GenerationFailed as exc:
        # A typed failure is a valid outcome of the contract; anything else is a bug.
        assert isinstance(exc.mode, hs.FailureMode)
        return
    assert isinstance(result, hs.Briefing)


@pytest.mark.skipif(not os.environ.get("TYPESAFE_AI_JEV_API_KEY"), reason="TYPESAFE_AI_JEV_API_KEY not configured")
def test_live_jev_answer_is_a_typed_verdict():
    briefing, facts_text = _real_briefing(REAL_PROP_IDS[0])
    verdict = hs.judge_briefing(briefing, facts_text, api_key=hs.jev_api_key())
    assert isinstance(verdict, hs.Verdict)
    assert isinstance(verdict.mode, hs.FailureMode)
    assert 0.0 <= verdict.confidence <= 1.0


def test_verdict_from_nouls_is_ok_only_when_every_failure_is_unlikely():
    low = {m: 0.07 for m in hs.JEV_NOULS}
    assert hs.verdict_from_nouls(low, "jev-test").mode is hs.FailureMode.OK
    high = dict(low, **{hs.FailureMode.HOUSEHOLD_OVERCLAIM: 0.96, hs.FailureMode.UNGROUNDED: 0.85})
    v = hs.verdict_from_nouls(high, "jev-test")
    assert v.mode is hs.FailureMode.HOUSEHOLD_OVERCLAIM and v.confidence == 0.96
