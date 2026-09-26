"""Upload a raw source file, unchanged, to the private Supabase Storage
bucket `raw`, keyed by source/date/sha256 so every object is content-
addressed and traceable to exactly one ops.source_manifest row.
"""
from __future__ import annotations

from datetime import datetime, timezone

from supabase import Client, create_client

from . import config

BUCKET = config.RAW_BUCKET


def storage_key(source: str, sha256: str, *, when: datetime | None = None, ext: str = "") -> str:
    """<source>/<YYYY-MM-DD>/<sha256><ext> — stable, content-addressed."""
    when = when or datetime.now(timezone.utc)
    date = when.strftime("%Y-%m-%d")
    return f"{source}/{date}/{sha256}{ext}"


def get_client() -> Client:
    return create_client(config.supabase_url(), config.supabase_secret_key())


def upload_raw(content: bytes, key: str, *, content_type: str = "application/octet-stream") -> str:
    """Upload `content` unchanged to bucket `raw` at `key`. Returns the key.
    Raises if the upload fails — callers must stop and report, never
    silently skip the manifest row."""
    client = get_client()
    client.storage.from_(BUCKET).upload(
        key,
        content,
        {"content-type": content_type, "upsert": "true"},
    )
    return key
