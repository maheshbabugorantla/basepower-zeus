-- 0307_batched_scoring_drop_pre_batched.sql — run only after
-- 0307_batched_scoring_swap.sql has been live and verified (parity
-- checks passed, /ranking and /home confirmed against the new table
-- path). Frees the ~1.1 GB the old matview copies still hold. Plain
-- drop, no cascade: fails loudly if anything still depends on them.
-- 0306's pre-swap block-group copy: mv_home_signals_pre_batched read it, so it
-- could only go once that reference copy was gone.
-- Reverse dependency order: terms reads signals, signals reads the pre-0306 block-group copy.
drop materialized view core.mv_home_terms_pre_batched;
drop materialized view core.mv_home_signals_pre_batched;
drop materialized view if exists core.mv_home_block_group_pre_0306;
