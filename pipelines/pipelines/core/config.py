"""Lazy environment-variable access. Never read at import time, and never
print/log a value — callers get the raw string or a clear KeyError.
"""
from __future__ import annotations

import os

RAW_BUCKET = "raw"


def require_env(name: str) -> str:
    """Return env var `name`, raising a clear error (never the value) if unset."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"required environment variable {name} is not set")
    return value


def cron_secret() -> str | None:
    """The CRON_SECRET value, or None if unset. Never logged."""
    return os.environ.get("CRON_SECRET") or None


def postgres_url() -> str:
    """POSTGRES_URL — the Supabase transaction pooler (port 6543)."""
    return require_env("POSTGRES_URL")


def postgres_url_non_pooling() -> str:
    """POSTGRES_URL_NON_POOLING — the session pooler (port 5432), for
    migrations and long CLI backfills."""
    return require_env("POSTGRES_URL_NON_POOLING")


def supabase_url() -> str:
    return require_env("SUPABASE_URL")


def supabase_secret_key() -> str:
    return require_env("SUPABASE_SECRET_KEY")
