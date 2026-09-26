"""Shared helpers for every pipeline module under pipelines/sources/.

The pipeline shape every source module (M0-P1 and later) follows:

    fetch -> upload raw bytes to Storage bucket `raw` -> ops.source_manifest
    row -> load into core.* tables -> ops.pipeline_runs row (cursor + drop
    counts)

Nothing in this package connects to anything at import time: every env
var (CRON_SECRET, POSTGRES_URL, SUPABASE_URL, SUPABASE_SECRET_KEY) is read
lazily, inside a function, so this package can be imported freely by CI
and by pytest without secrets set.
"""
