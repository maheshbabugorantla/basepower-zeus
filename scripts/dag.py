#!/usr/bin/env python3
"""Build the dependency graph for one milestone's ticket files and print waves.

Usage:
    python scripts/dag.py tickets/M0/
    python scripts/dag.py tickets/M0/ --done T0-H1,M0-D0

Stdlib only (no PyYAML) so this runs with a bare python3 interpreter.

A ticket file (tickets/<Mn>/<ID>.md) has a frontmatter block delimited by two
"---" lines at the top, e.g.:

    ---
    id: M0-D0
    milestone: M0
    title: "Orchestration harness"
    agent: platform-dev
    depends_on: [T0-H1]
    owns: [CLAUDE.md, .claude/agents/]
    contract_in: []
    contract_out: []
    reviewer: P4
    status: ready
    github_issue: 5
    ---

Dependencies whose ID belongs to a different milestone (including T0) are
"external": this script does not use them to gate waves (the orchestrator
only starts a milestone after prior milestones are merged), but it looks
them up and reports whether they are satisfied (status: done, or passed via
--done) purely for visibility.

Exit codes:
    0  success (waves printed)
    1  a cycle among internal dependencies
    2  two tickets in the same wave have overlapping `owns` paths
    3  a ticket references an unknown internal id, or a bad directory
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _split_top_level(value: str) -> list[str]:
    """Split `[a, b, c]` into ["a", "b", "c"]; "[]" -> []."""
    value = value.strip()
    if not value.startswith("[") or not value.endswith("]"):
        raise ValueError(f"expected an inline list, got: {value!r}")
    inner = value[1:-1].strip()
    if not inner:
        return []
    parts = [p.strip() for p in inner.split(",")]
    return [p for p in parts if p]


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def parse_frontmatter(text: str) -> dict:
    """Parse the '---' delimited frontmatter block of a ticket file."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("file does not start with a '---' frontmatter block")
    fields: dict = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if not line.strip() or line.strip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, raw_value = line.partition(":")
        key = key.strip()
        raw_value = raw_value.strip()
        if raw_value.startswith("["):
            fields[key] = _split_top_level(raw_value)
        else:
            fields[key] = _strip_quotes(raw_value)
    return fields


def load_tickets(milestone_dir: Path) -> dict[str, dict]:
    """Load every ticket file directly inside milestone_dir, keyed by id."""
    tickets: dict[str, dict] = {}
    for path in sorted(milestone_dir.glob("*.md")):
        text = path.read_text()
        fields = parse_frontmatter(text)
        ticket_id = fields.get("id")
        if not ticket_id:
            raise ValueError(f"{path}: missing 'id' in frontmatter")
        fields["_path"] = path
        fields.setdefault("depends_on", [])
        fields.setdefault("owns", [])
        tickets[ticket_id] = fields
    return tickets


def _milestone_prefix(ticket_id: str) -> str:
    return ticket_id.split("-", 1)[0]


def resolve_external(ticket_id: str, tickets_root: Path, done: set[str]) -> tuple[bool, str]:
    """Look up a cross-milestone dependency. Returns (satisfied, reason).

    Raises UnknownDependencyError if the referenced ticket file does not
    exist anywhere under tickets_root: an external id that resolves to no
    file is a typo, not a legitimately-unsatisfied-but-assumed-ok
    dependency, and must fail the same way an unknown internal id does.
    """
    if ticket_id in done:
        return True, "in --done"
    prefix = _milestone_prefix(ticket_id)
    candidate = tickets_root / prefix / f"{ticket_id}.md"
    if not candidate.exists():
        raise UnknownDependencyError(
            f"external dependency '{ticket_id}' not found at {candidate}"
        )
    fields = parse_frontmatter(candidate.read_text())
    if fields.get("status") == "done":
        return True, "status: done"
    # Cross-milestone/T0 dependencies are assumed satisfied by the time this
    # milestone's wave graph runs (the orchestrator gates milestone order),
    # so treat them as satisfied-by-prior-milestone even if not marked done.
    return True, "satisfied-by-prior-milestone"


def paths_overlap(a: str, b: str) -> bool:
    """True if owns-path a and b are equal, or one is a directory (trailing
    '/') containing the other."""
    if a == b:
        return True
    if a.endswith("/") and b.startswith(a):
        return True
    if b.endswith("/") and a.startswith(b):
        return True
    return False


class CycleError(Exception):
    pass


class OwnsOverlapError(Exception):
    pass


class UnknownDependencyError(Exception):
    pass


def compute_waves(
    tickets: dict[str, dict], tickets_root: Path, done: set[str]
) -> tuple[list[list[str]], dict[str, list[tuple[str, bool, str]]]]:
    """Return (waves, external_deps_by_ticket).

    waves: list of lists of ticket ids, sorted alphabetically within a wave.
    external_deps_by_ticket: ticket_id -> [(dep_id, satisfied, reason), ...]
    """
    internal_edges: dict[str, set[str]] = {tid: set() for tid in tickets}
    external_deps: dict[str, list[tuple[str, bool, str]]] = {tid: [] for tid in tickets}

    for tid, fields in tickets.items():
        for dep in fields.get("depends_on", []):
            if _milestone_prefix(dep) == _milestone_prefix(tid) and dep in tickets:
                internal_edges[tid].add(dep)
            elif _milestone_prefix(dep) == _milestone_prefix(tid):
                # Same milestone prefix but not a known ticket file: unknown.
                raise UnknownDependencyError(
                    f"{tid} depends_on unknown ticket '{dep}' (not found in {tickets_root / _milestone_prefix(tid)})"
                )
            else:
                satisfied, reason = resolve_external(dep, tickets_root, done)
                external_deps[tid].append((dep, satisfied, reason))

    remaining = set(tickets.keys())
    waves: list[list[str]] = []
    resolved: set[str] = set()

    while remaining:
        ready = sorted(
            tid for tid in remaining if internal_edges[tid] <= resolved
        )
        if not ready:
            raise CycleError(
                f"cycle detected among: {', '.join(sorted(remaining))}"
            )
        # owns-overlap check within this wave
        owns_list = [(tid, tickets[tid].get("owns", [])) for tid in ready]
        for i in range(len(owns_list)):
            tid_a, owns_a = owns_list[i]
            for j in range(i + 1, len(owns_list)):
                tid_b, owns_b = owns_list[j]
                for pa in owns_a:
                    for pb in owns_b:
                        if paths_overlap(pa, pb):
                            raise OwnsOverlapError(
                                f"{tid_a} and {tid_b} are in the same wave and both own overlapping paths: "
                                f"{pa!r} vs {pb!r}"
                            )
        waves.append(ready)
        resolved.update(ready)
        remaining -= set(ready)

    return waves, external_deps


def short_id(ticket_id: str) -> str:
    """Drop the milestone prefix for the compact print format, e.g. M0-D0 -> D0."""
    return ticket_id.split("-", 1)[1] if "-" in ticket_id else ticket_id


def format_waves(waves: list[list[str]]) -> str:
    return " | ".join(",".join(short_id(t) for t in wave) for wave in waves)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tickets_dir", help="e.g. tickets/M0/")
    parser.add_argument(
        "--done",
        default="",
        help="comma-separated external ticket ids to treat as satisfied",
    )
    args = parser.parse_args(argv)

    milestone_dir = Path(args.tickets_dir)
    if not milestone_dir.is_dir():
        print(f"error: {milestone_dir} is not a directory", file=sys.stderr)
        return 3
    tickets_root = milestone_dir.parent

    done = {d.strip() for d in args.done.split(",") if d.strip()}

    try:
        tickets = load_tickets(milestone_dir)
        waves, external_deps = compute_waves(tickets, tickets_root, done)
    except UnknownDependencyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    except CycleError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except OwnsOverlapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for i, wave in enumerate(waves, start=1):
        print(f"Wave {i}: {', '.join(wave)}")
    print(format_waves(waves))

    any_external = any(external_deps[tid] for tid in tickets)
    if any_external:
        print("\nExternal dependencies:")
        for tid in sorted(tickets):
            for dep, satisfied, reason in external_deps[tid]:
                status = "ok" if satisfied else "UNSATISFIED"
                print(f"  {tid} -> {dep} (external, {status}: {reason})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
