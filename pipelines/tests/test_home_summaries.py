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


def test_process_one_falls_back_to_template_when_guard_fails(monkeypatch):
    """The failure path (guard rejects the reply) stores/returns the
    deterministic template, never the ungrounded reply. The real DB row,
    real facts and real breakdown are untouched; only the Gemini network
    call itself is replaced with a fixed, deliberately ungrounded string
    so the failure path is exercised deterministically (Gemini's own
    output is not reproducible on demand) — no fact or DB row here is
    fabricated, only the simulated failure of the external network call.
    The prop_id's real pre-generated row (written for this ticket's
    backfill) is snapshotted before and restored after, so this test
    never leaves the real backfill row overwritten by the simulated
    failure."""
    prop_id = REAL_PROP_IDS[0]

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select summary, is_template, guard_failed, model, prompt_version, facts_hash, "
                "source_ids, generated_at from core.home_summary where prop_id = %s",
                (prop_id,),
            )
            snapshot = cur.fetchone()

    def fake_call_gemini(facts_text, *, api_key, model, timeout=hs.GEMINI_TIMEOUT_S):
        return "This home also had 999999999 total incidents."

    monkeypatch.setattr(hs, "call_gemini", fake_call_gemini)
    # Force regeneration even if a prior real run already stored a row.
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update core.home_summary set facts_hash = 'force-regen' where prop_id = %s", (prop_id,))

    try:
        result = hs.process_one(prop_id, api_key="unused", model="unused")
        assert result["skipped"] is False
        assert result["is_template"] is True
        assert result["guard_failed"] is True

        with db.connect(pooled=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "select summary, is_template, guard_failed, model from core.home_summary where prop_id = %s",
                    (prop_id,),
                )
                summary, is_template, guard_failed, model = cur.fetchone()
        assert is_template is True
        assert guard_failed is True
        assert model is None
        assert "999999999" not in summary
    finally:
        if snapshot is not None:
            with db.connect(pooled=False) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        insert into core.home_summary
                            (prop_id, summary, is_template, guard_failed, model, prompt_version,
                             facts_hash, source_ids, generated_at)
                        values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        on conflict (prop_id) do update set
                            summary = excluded.summary, is_template = excluded.is_template,
                            guard_failed = excluded.guard_failed, model = excluded.model,
                            prompt_version = excluded.prompt_version, facts_hash = excluded.facts_hash,
                            source_ids = excluded.source_ids, generated_at = excluded.generated_at
                        """,
                        (prop_id, *snapshot),
                    )


@pytest.mark.skipif(
    not (os.environ.get("GEMINI_API_KEY") and os.environ.get("BRIEF_MODEL")),
    reason="GEMINI_API_KEY/BRIEF_MODEL not configured",
)
def test_process_one_is_idempotent_on_unchanged_facts():
    prop_id = REAL_PROP_IDS[1]
    api_key = hs.gemini_api_key()
    model = hs.brief_model()

    first = hs.process_one(prop_id, api_key=api_key, model=model)
    assert first["skipped"] in (True, False)
    second = hs.process_one(prop_id, api_key=api_key, model=model)
    assert second == {"prop_id": prop_id, "skipped": True, "reason": "unchanged_facts_hash"}
