-- 0307_batched_scoring_drop_pre_batched.sql — run only after
-- 0307_batched_scoring_swap.sql has been live and verified (parity
-- checks passed, /ranking and /home confirmed against the new table
-- path). Frees the ~1.1 GB the old matview copies still hold. Plain
-- drop, no cascade: fails loudly if anything still depends on them.
drop materialized view core.mv_home_signals_pre_batched;
drop materialized view core.mv_home_terms_pre_batched;
