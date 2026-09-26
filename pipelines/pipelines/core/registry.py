"""Discover pipeline source modules under pipelines/sources/.

Source-module contract (documented here for pipeline-dev tickets, e.g.
M0-P1): a module at pipelines/sources/<name>.py must expose

    def run(*, runner: Literal["cron", "cli"], backfill: bool = False,
            cursor: dict | None = None) -> None: ...

`run()` does the fetch -> storage.upload_raw -> manifest.insert ->
load-into-core -> runs.start/finish sequence for that one source, using
the shared helpers in pipelines.pipelines.core. The cron route and the
CLI entrypoint (pipelines/pipelines/run.py) both call this same `run()`.

Discovery here is deliberately tolerant of `pipelines/sources/` being
empty (only __init__.py, or not existing at all yet) — this ticket
(M0-D1) creates no source module itself, per the real-data rule (no
placeholder source to have something to call).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def _sources_dir() -> Path:
    # pipelines/pipelines/core/registry.py -> parents[2] is the pipelines/
    # project root (sibling of app.py) -> pipelines/sources/
    return Path(__file__).resolve().parents[2] / "sources"


def list_source_names() -> list[str]:
    """Every <name> with a pipelines/sources/<name>.py module. Empty list
    if the directory doesn't exist or holds no source modules yet."""
    sources_dir = _sources_dir()
    if not sources_dir.is_dir():
        return []
    names = []
    for path in sorted(sources_dir.glob("*.py")):
        if path.stem == "__init__":
            continue
        names.append(path.stem)
    return names


def load_source(name: str) -> ModuleType | None:
    """Load pipelines/sources/<name>.py by file path (not a dotted import,
    since sources/ may or may not be on sys.path depending on how the app
    was invoked — cron via app.py, CLI via -m, or pytest) and return the
    module, or None if no such source module exists."""
    sources_dir = _sources_dir()
    path = sources_dir / f"{name}.py"
    if name not in list_source_names() or not path.is_file():
        return None

    module_name = f"pipelines_sources_{name}"
    if module_name in sys.modules:
        return sys.modules[module_name]

    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module
