"""CLI entrypoint: python -m pipelines.run <source> [--backfill]

Runs the same pipelines/sources/<name>.py `run()` entrypoint the cron
route calls, with runner="cli" so ops.source_manifest / ops.pipeline_runs
record how the run happened. Used for the orchestrator's Vercel-duration
fallback: when a single file can't finish inside one 300 s function call,
run it from the CLI instead — same tables, runner marked 'cli'.
"""
from __future__ import annotations

import argparse
import sys

from pipelines.core import registry


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m pipelines.run",
        description=__doc__,
    )
    parser.add_argument("source", help="name of a pipelines/sources/<name>.py module")
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="run a full backfill instead of an incremental update",
    )
    args = parser.parse_args(argv)

    module = registry.load_source(args.source)
    if module is None:
        available = registry.list_source_names()
        print(
            f"error: no source module {args.source!r} "
            f"(pipelines/sources/{args.source}.py). "
            f"Available: {available or '(none yet)'}",
            file=sys.stderr,
        )
        return 1

    run_fn = getattr(module, "run", None)
    if run_fn is None:
        print(f"error: source module {args.source!r} has no run()", file=sys.stderr)
        return 1

    run_fn(runner="cli", backfill=args.backfill)
    return 0


if __name__ == "__main__":
    sys.exit(main())
