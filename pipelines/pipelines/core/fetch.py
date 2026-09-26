"""Download a source file and compute its SHA-256, unchanged.

This module never fabricates bytes: fetch() returns exactly the response
body from the given URL, or raises. Callers pass those bytes, unmodified,
to storage.upload_raw() and the same sha256 to manifest.insert().
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class Fetched:
    url: str
    content: bytes
    sha256: str
    bytes: int


def fetch(url: str, *, timeout: float = 120.0, **kwargs) -> Fetched:
    """GET `url` and return its raw bytes plus SHA-256. Raises on any
    non-2xx response — callers must stop and report, never substitute a
    placeholder, per the real-data rule."""
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        response = client.get(url, **kwargs)
    response.raise_for_status()
    content = response.content
    digest = hashlib.sha256(content).hexdigest()
    return Fetched(url=url, content=content, sha256=digest, bytes=len(content))


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
