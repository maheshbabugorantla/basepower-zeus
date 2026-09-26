"""Real-Storage test for pipelines/pipelines/core/storage.py.

No new Storage object is created. Per the real-data rule and this
ticket's brief, this test re-uploads an EXISTING ops.source_manifest
object's own bytes back to its own key (upsert), then verifies the
re-uploaded object's sha256 still matches the manifest row. This is the
regression test for the bug this ticket fixes: storage.upload_raw() used
supabase-py's create_client(), which rejects this project's new-format
`sb_secret_...` service-role key with "Invalid API key" for every call —
so any call to upload_raw() failed outright, whether or not the object
already existed.

Skipped, not failed, when POSTGRES_URL / Supabase secrets are unset (CI
has none — see .github/workflows/ci.yml), matching test_check.py.
"""
from __future__ import annotations

import hashlib
import os

import httpx
import pytest

from pipelines.core import config, db, storage

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL"),
    reason="requires POSTGRES_URL (and Supabase secrets) in the environment; CI has no DB secrets",
)


def _query(sql: str, params: tuple = ()) -> list[tuple]:
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def _download(key: str) -> bytes:
    base_url = config.supabase_url().rstrip("/")
    url = f"{base_url}/storage/v1/object/{config.RAW_BUCKET}/{key}"
    headers = {
        "apikey": config.supabase_secret_key(),
        "Authorization": f"Bearer {config.supabase_secret_key()}",
    }
    resp = httpx.get(url, headers=headers, timeout=120.0)
    resp.raise_for_status()
    return resp.content


def _download_sha256(key: str) -> str:
    return hashlib.sha256(_download(key)).hexdigest()


def _smallest_manifest_row() -> tuple[str, str, int] | None:
    """Return (storage_key, sha256, bytes) of the manifest row with the
    smallest recorded byte count that is still comfortably under the 50 MB
    plain-PUT threshold, so this test exercises upload_raw()'s PUT branch
    (not the TUS branch, which eaglei.py/tiger_bg.py already prove) without
    downloading/uploading anything large."""
    rows = _query(
        "select storage_key, sha256, bytes from ops.source_manifest "
        "where bytes is not null and bytes < %s order by bytes asc limit 1",
        (storage.TUS_THRESHOLD_BYTES,),
    )
    if not rows:
        return None
    return rows[0]


def test_upload_raw_reuploads_existing_object_to_same_key(capsys):
    row = _smallest_manifest_row()
    if row is None:
        pytest.skip("no ops.source_manifest row with bytes < TUS_THRESHOLD_BYTES exists yet to re-upload")
    key, expected_sha256, expected_bytes = row

    # Confirm the object currently in Storage matches the manifest before
    # touching anything, and capture its real mimetype so the re-upload
    # doesn't rewrite the object's metadata to a different content-type.
    (mimetype,) = _query(
        "select metadata->>'mimetype' from storage.objects where bucket_id = %s and name = %s",
        (config.RAW_BUCKET, key),
    )[0]
    assert mimetype, f"expected existing Storage object metadata for {key!r}"

    content = _download(key)
    assert hashlib.sha256(content).hexdigest() == expected_sha256
    assert len(content) == expected_bytes

    # This is the exact call that used to raise SupabaseException("Invalid
    # API key") before this ticket's fix.
    returned_key = storage.upload_raw(content, key, content_type=mimetype)
    assert returned_key == key

    after_sha256 = _download_sha256(key)
    assert after_sha256 == expected_sha256
    assert hashlib.sha256(content).hexdigest() == expected_sha256


def test_upload_raw_rejects_bad_key_cleanly():
    # A key with no upstream prefix directory can't collide with anything
    # real, and Storage should reject it with an httpx error rather than
    # the SDK's "Invalid API key" masking every other failure mode.
    with pytest.raises(httpx.HTTPStatusError):
        storage.upload_raw(b"", "", content_type="application/octet-stream")
