-- Each stored "why this home" summary records how it was checked: the
-- TypeSafe Jev verdict on the final text (ok / cut_off / ungrounded /
-- wrong_voice / household_overclaim / formatting / off_task), Jev's
-- confidence, the judge model id, and how many Gemini attempts it took.
alter table core.home_summary
  add column if not exists judge_verdict text,
  add column if not exists judge_confidence numeric,
  add column if not exists judge_model text,
  add column if not exists attempts integer;

-- The typed briefing (lead_reason, supporting_reason, neighborhood_context)
-- that `summary` was joined from; null when the deterministic template was
-- stored. judge_verdict holds the final typed failure mode ('ok' when accepted).
alter table core.home_summary add column if not exists briefing jsonb;
alter table core.home_summary drop constraint if exists home_summary_judge_verdict_chk;
alter table core.home_summary add constraint home_summary_judge_verdict_chk check (
  judge_verdict is null or judge_verdict in (
    'ok', 'cut_off', 'ungrounded', 'wrong_voice', 'household_overclaim', 'formatting',
    'off_task', 'schema_invalid', 'judge_unavailable', 'gemini_error'));
