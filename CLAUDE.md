# Base Power Zeus — CLAUDE.md

This repo builds a Vercel-hosted app that ranks Texas homes and
neighborhoods for Base Power outreach, on real public data only. Every
number on screen must link back to its source file. This file loads for
every Claude Code session and every subagent in `.claude/agents/`,
including any built-in subagent the orchestrator invokes.

## Tracer-bullet method

Each milestone is a thin vertical slice built end to end before the next
one widens it — real file in, map and ranked list out, with a passing
test. The loop, from [Tracer Bullets: Keeping AI Slop Under
Control](https://www.aihero.dev/tracer-bullets) (Matt Pocock, AI Hero):

1. Build a small feature end to end.
2. Test it immediately.
3. Get feedback.
4. Start the next slice in a fresh context window.

This prevents the usual failure mode: building whole layers in isolation,
then finding at integration time that the pieces don't fit.

- Every milestone touches all four layers — Python pipeline → Supabase →
  `api` views → Next.js on Vercel — never one layer alone.
- Grow width, not depth: add datasets or counties, never a new layer.
- Each ticket is a slice of the slice, built independently against a
  schema contract, by a fresh Sonnet 5 subagent in its own worktree.
- A milestone passes only when its V ticket passes on a Vercel preview,
  against real data in Supabase.

## The real-data rule (non-negotiable)

Never generate synthetic, sample, mock, or placeholder data, including in tests.
Only load data that comes from a raw file with an ops.source_manifest row.
If a needed source is missing or fails to download, stop and report it. Do not substitute values.
Edit only your ticket's owns paths. Build the thinnest slice that fills its contract_out, then run its Acceptance commands.

Concretely:

1. **Traceable.** Every row traces to a downloaded source file, recorded
   with its URL, retrieval time, and SHA-256 checksum.
2. **Nothing invented.** No synthetic rows, no hard-coded sample arrays,
   no placeholder values, no seeded fakes in tests. Tests run against
   real extracts (byte slices of the real file, with a sidecar recording
   the source object and byte range).
3. **Missing means empty.** An unloaded feature is null with a reason;
   the UI shows "not loaded" or "not available", never an estimate.
   Never `COALESCE(x, 0)` or `fillna(0)` on a signal column.
4. **No made-up dollars.** Base's internal numbers are not public and are
   left out of the score. The only dollar values shown are ERCOT market
   prices.

CI and every V ticket run `scripts/no_mock_check.py` (checks 3, 4, 6) and
`scripts/dag.py` (wave ordering, cycle and owns-overlap detection).

## Design: read before any UI work

Read `DESIGN.md` and `PRODUCT.md` in the repo root before touching any
page or component. Reuse tokens and base components from `web/styles/`
and `web/components/ui/`; do not invent new ones.

## Platform facts

- **Use `python3`, not `python`.** There is no plain `python` on PATH in
  this environment; every command in this repo (`dag.py`,
  `no_mock_check.py`, `pipelines.check`, `pipelines.run`) is invoked with
  `python3`. `uv run --with <pkg> <cmd>` is available for one-off deps.
- **Vercel plan is Hobby.** Functions max out at 300 s and 2 GB memory,
  crons run at most once a day, one concurrent build. Size backfill
  chunks to finish well under 300 s.
- **Vercel scope rule.** Every `vercel` command targets team scope
  `gorantlasubs-gmailcoms-projects` and only the two projects
  `base-power-zeus` (web) and `base-power-zeus-pipelines`. Never touch
  any other project or domain. Never run `vercel` from the repo root.
- **Env var names (values never appear in code, logs, or commits):**
  `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service-role, `sb_secret_`
  format), `SUPABASE_PUBLISHABLE_KEY` (never for data), `POSTGRES_URL`,
  `POSTGRES_URL_NON_POOLING`, `CRON_SECRET`, `ERCOT_USERNAME`,
  `ERCOT_PASSWORD`, `ERCOT_SUBSCRIPTION_KEY`, `CENSUS_API_KEY`,
  `GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY` + `BRIEF_MODEL` (server-only
  "why this home" summaries), `TYPESAFE_AI_JEV_API_KEY` (labeling model
  for classifier spot checks, like the M1 permit labels).
- **Pooler URLs.** `POSTGRES_URL` is the transaction pooler (port 6543) —
  psycopg must use `prepare_threshold=None`. `POSTGRES_URL_NON_POOLING`
  is the session pooler (port 5432) — use it for migrations and long CLI
  backfills. The direct DB host is IPv6-only and unreachable here; always
  use a pooler URL.
- PostGIS 3.3.7 is installed in schema `extensions`.
- Secrets are loaded from an untracked `.env` outside the worktree; never
  copy `.env` into a worktree, and never print, echo, log, or commit a
  value from it. `.env.example` holds variable names only.

## Subagent roster

`.claude/agents/` holds `schema-dev`, `pipeline-dev`, `web-dev`,
`platform-dev`, `verifier` (all `model: claude-sonnet-5`) and
`orchestrator`. `.claude/settings.json` pins
`CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5` with
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` so any built-in subagent the
orchestrator calls runs on Sonnet 5 too. Start the orchestrator with
`claude --agent orchestrator`, then say `Run milestone M1`.

## Ticket workflow

Each ticket file (`tickets/<Mn>/<ID>.md`) has a YAML-ish frontmatter block
(`id`, `milestone`, `title`, `agent`, `depends_on`, `owns`, `contract_in`,
`contract_out`, `reviewer`, `status`) followed by "What to build",
"Acceptance criteria", and "Blocked by". A subagent edits only its
ticket's `owns` paths; files under `contract_in` are read-only. Build the
thinnest slice that fills `contract_out`, then run every Acceptance
command and report: branch name, files changed, and PASS/FAIL with the
last ~40 lines of output for each Acceptance item.

Run `python3 scripts/dag.py tickets/<Mn>/` to get the wave order before
dispatching a milestone. It fails on a cycle or on two same-wave tickets
whose `owns` paths overlap.

### Fixture sidecar format (check 4)

A fixture under any `fixtures/` directory must have a sidecar
`<file>.source.json` next to it recording:

```json
{ "source_object": "eaglei_outages_2024.csv", "byte_start": 10000, "byte_end": 20480 }
```

`byte_end - byte_start` must equal the fixture file's size in bytes.
