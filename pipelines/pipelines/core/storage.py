"""Upload a raw source file, unchanged, to the private Supabase Storage
bucket `raw`, keyed by source/date/sha256 so every object is content-
addressed and traceable to exactly one ops.source_manifest row.

Uses direct Storage REST calls (Bearer + apikey headers), never
supabase-py's create_client(): SyncClient.__init__ regex-checks
supabase_key as a 2/3-part JWT, and this project's new-format
`sb_secret_...` service-role key has no dots, so create_client() raises
`SupabaseException("Invalid API key")` for every call — see
sources/tiger_bg.py's module docstring, which first diagnosed this. This
module is that fix generalized into shared plumbing: a plain PUT for
objects <= 50 MB (tiger_bg.py's `_upload_zip` pattern), and Supabase's
TUS-compatible resumable-upload endpoint (6 MiB PATCH chunks) for larger
ones, ported from eaglei.py's proven `_tus_create`/`_tus_upload_file`
logic (which exists because supabase-py's `.upload()` also loads its
whole payload into memory, and TUS avoids that for multi-hundred-MB/GB
files). eaglei.py and tiger_bg.py are left untouched; each still carries
its own copy of this logic inline (ticket boundary), but new source
modules should call this instead of duplicating it again.
"""
from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone

import httpx

from . import config

BUCKET = config.RAW_BUCKET

# Supabase's plain (non-resumable) object PUT is limited well under this;
# TUS resumable upload is used for anything bigger. eaglei.py's 1.4 GB CSV
# and parcels.py's 557 MB zip both use TUS; tiger_bg.py's ~50 MB shapefile
# zip uses a plain PUT.
TUS_THRESHOLD_BYTES = 50 * 1024 * 1024
TUS_CHUNK_BYTES = 6 * 1024 * 1024  # Supabase's documented resumable-upload chunk size


def storage_key(source: str, sha256: str, *, when: datetime | None = None, ext: str = "") -> str:
    """<source>/<YYYY-MM-DD>/<sha256><ext> — stable, content-addressed."""
    when = when or datetime.now(timezone.utc)
    date = when.strftime("%Y-%m-%d")
    return f"{source}/{date}/{sha256}{ext}"


def _auth_headers() -> dict[str, str]:
    service_key = config.supabase_secret_key()
    # Both apikey and Authorization: Bearer are required for the
    # service-role (sb_secret_*) key, since it is not itself a JWT that
    # the Storage API would otherwise accept as a bearer alone — same
    # convention as check.py's cmd_manifest and eaglei.py/tiger_bg.py.
    return {"apikey": service_key, "Authorization": f"Bearer {service_key}"}


def _put_object(content: bytes, key: str, *, content_type: str) -> None:
    """PUT `content` unchanged to bucket `raw` at `key` via a plain (non-
    resumable) object PUT. Raises on any non-2xx response. Only for
    payloads under TUS_THRESHOLD_BYTES — Storage rejects a plain PUT above
    its own request-size limit."""
    base_url = config.supabase_url().rstrip("/")
    url = f"{base_url}/storage/v1/object/{BUCKET}/{key}"
    headers = dict(_auth_headers(), **{"Content-Type": content_type, "x-upsert": "true"})
    resp = httpx.put(url, headers=headers, content=content, timeout=120.0)
    resp.raise_for_status()


def _tus_b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def _tus_create(*, base_url: str, headers: dict[str, str], key: str, content_type: str, length: int) -> str:
    meta = (
        f"bucketName {_tus_b64(BUCKET)},"
        f"objectName {_tus_b64(key)},"
        f"contentType {_tus_b64(content_type)}"
    )
    create_headers = dict(
        headers,
        **{
            "Tus-Resumable": "1.0.0",
            "Upload-Length": str(length),
            "Upload-Metadata": meta,
            "x-upsert": "true",
        },
    )
    resp = httpx.post(f"{base_url}/storage/v1/upload/resumable", headers=create_headers, timeout=60.0)
    resp.raise_for_status()
    location = resp.headers.get("location")
    if not location:
        raise RuntimeError("TUS create response had no Location header")
    return location


def _tus_upload(content: bytes, key: str, *, content_type: str) -> None:
    """Upload `content` unchanged to bucket `raw` at `key` via Supabase's
    TUS-compatible resumable-upload endpoint, in TUS_CHUNK_BYTES PATCH
    chunks (a memoryview slice each time, never a copy) — ported from
    eaglei.py's proven `_tus_create`/`_tus_upload_file`. Raises on any
    non-2xx response."""
    base_url = config.supabase_url().rstrip("/")
    headers = _auth_headers()
    length = len(content)
    location = _tus_create(base_url=base_url, headers=headers, key=key, content_type=content_type, length=length)

    view = memoryview(content)
    offset = 0
    patch_headers_base = dict(headers, **{"Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream"})
    with httpx.Client(timeout=120.0) as client:
        while offset < length:
            chunk = view[offset : offset + TUS_CHUNK_BYTES]
            if not chunk:
                break
            patch_headers = dict(patch_headers_base, **{"Upload-Offset": str(offset)})
            resp = client.patch(location, headers=patch_headers, content=bytes(chunk))
            resp.raise_for_status()
            offset = int(resp.headers["upload-offset"])


def upload_raw(content: bytes, key: str, *, content_type: str = "application/octet-stream") -> str:
    """Upload `content` unchanged to bucket `raw` at `key`. Returns the key.
    Raises if the upload fails — callers must stop and report, never
    silently skip the manifest row.

    A plain PUT is used for objects up to TUS_THRESHOLD_BYTES; larger
    objects go through TUS resumable upload, since Supabase Storage's
    plain object PUT is not viable for large payloads (see the module
    docstring)."""
    if len(content) > TUS_THRESHOLD_BYTES:
        _tus_upload(content, key, content_type=content_type)
    else:
        _put_object(content, key, content_type=content_type)
    return key
