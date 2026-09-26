#!/usr/bin/env python3
"""Real-data verification: automated checks 3, 4, and 6 from the build spec.

Check 3 (no-mock scan): fails on, inside pipelines/, web/, or supabase/:
  - fake-data libraries (Faker, Mimesis, @faker-js/faker)
  - `random` / `np.random` / `numpy.random` in pipeline code (pipelines/ only)
  - literal record arrays longer than 5 rows in code or tests
  - file names containing mock, fake, dummy, or sample

Check 4 (fixtures are real): every file under a `fixtures/` directory must
have a sidecar `<file>.source.json` recording the source object and byte
range it was sliced from (keys: source_object, byte_start, byte_end).

Check 6 (no zero-filling): rejects `COALESCE(x, 0)` and `fillna(0)` /
`fillna(0.0)` / `fillna(value=0)` on signal columns.

Usage:
    python scripts/no_mock_check.py [--root PATH]

Exit 0 if no violation found (or the scanned dirs don't exist yet), else
prints every violation and exits 1. This script and its own tests
(scripts/no_mock_check.py, scripts/tests/test_no_mock_check.py) are never
scanned or flagged.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

SCAN_DIRS = ("pipelines", "web", "supabase")

# Directories we never descend into: generated/vendored trees that will
# legitimately contain the words "mock"/"sample"/"fake" once npm/pip
# installs run, plus VCS/build noise.
SKIP_DIR_NAMES = {
    "node_modules",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".vercel",
    "dist",
    "build",
    ".git",
    ".pytest_cache",
}

BAD_NAME_TOKENS = ("mock", "fake", "dummy", "sample")

FAKE_LIB_PY_RE = re.compile(r"\b(faker|mimesis)\b", re.IGNORECASE)
FAKE_LIB_JS_RE = re.compile(r"@faker-js/faker|\bmimesis\b", re.IGNORECASE)
RANDOM_PY_RE = re.compile(
    r"^\s*(import\s+random\b|from\s+random\s+import|import\s+numpy\.random\b)"
    r"|(?:\bnp\.random\b|\bnumpy\.random\b)",
    re.MULTILINE,
)

# COALESCE(<anything up to one level of nested parens>, 0[.0]) or
# fillna(0 | 0.0 | value=0)
COALESCE_ZERO_RE = re.compile(
    r"COALESCE\s*\(\s*[^()]*(?:\([^()]*\)[^()]*)*,\s*0(?:\.0+)?\s*\)",
    re.IGNORECASE,
)
FILLNA_ZERO_RE = re.compile(
    r"fillna\s*\(\s*(?:value\s*=\s*)?0(?:\.0+)?\s*\)",
    re.IGNORECASE,
)

TEXT_SUFFIXES = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".sql", ".json", ".yaml", ".yml",
    ".md", ".toml", ".cfg", ".ini", ".txt", ".mjs", ".cjs",
}

SELF_PATHS = {
    Path(__file__).resolve(),
}


class Violation:
    def __init__(self, check: str, path: Path, detail: str):
        self.check = check
        self.path = path
        self.detail = detail

    def __str__(self) -> str:
        return f"[check {self.check}] {self.path}: {self.detail}"


def is_self(path: Path) -> bool:
    resolved = path.resolve()
    if resolved in SELF_PATHS:
        return True
    # Never flag this script's own tests.
    return resolved.name == "test_no_mock_check.py"


def iter_files(root: Path):
    for scan_name in SCAN_DIRS:
        scan_dir = root / scan_name
        if not scan_dir.is_dir():
            continue
        for path in scan_dir.rglob("*"):
            if not path.is_file():
                continue
            # Check generated-dir membership against the path *relative to
            # root*, not the absolute path — an absolute-path check would
            # false-skip everything when the repo itself is checked out
            # under a directory named e.g. "build" or "dist".
            rel_parts = path.relative_to(root).parts
            if any(part in SKIP_DIR_NAMES for part in rel_parts):
                continue
            if is_self(path):
                continue
            yield path


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="strict")
    except (UnicodeDecodeError, OSError):
        return None


# ---- Check 3: no-mock scan -------------------------------------------------

def check_filename(path: Path, rel_parts: tuple) -> list[Violation]:
    # Check every path component under the scanned root, not just the leaf
    # file name: Jest/Vitest mock modules live in a __mocks__/ directory
    # with an otherwise clean file name, and that must still be caught.
    for part in rel_parts:
        part_lower = part.lower()
        for token in BAD_NAME_TOKENS:
            if token in part_lower:
                return [Violation("3", path, f"path component {part!r} contains {token!r}")]
    return []


def check_fake_libraries(path: Path, text: str) -> list[Violation]:
    violations = []
    if path.suffix == ".py":
        if FAKE_LIB_PY_RE.search(text):
            violations.append(Violation("3", path, "imports a fake-data library (Faker/Mimesis)"))
    elif path.suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"):
        if FAKE_LIB_JS_RE.search(text):
            violations.append(Violation("3", path, "references a fake-data library (@faker-js/faker/mimesis)"))
    return violations


def check_random(path: Path, rel_parts: tuple, text: str) -> list[Violation]:
    if path.suffix != ".py":
        return []
    if "pipelines" not in rel_parts:
        return []
    if RANDOM_PY_RE.search(text):
        return [Violation("3", path, "uses random/np.random in pipeline code")]
    return []


def _py_literal_row_count(node: ast.AST) -> int | None:
    """If node is a List/Tuple of Dict/List/Tuple elements, return its
    element count (a "record array"); else None."""
    if not isinstance(node, (ast.List, ast.Tuple)):
        return None
    if not node.elts:
        return None
    if all(isinstance(e, (ast.Dict, ast.List, ast.Tuple)) for e in node.elts):
        return len(node.elts)
    return None


def check_literal_record_arrays_py(path: Path, text: str) -> list[Violation]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    violations = []
    for node in ast.walk(tree):
        count = _py_literal_row_count(node)
        if count is not None and count > 5:
            violations.append(
                Violation("3", path, f"literal record array with {count} rows (>5)")
            )
    return violations


# Heuristic for JS/TS arrays of object literals, and SQL VALUES lists.
# ">5 rows" means 6 or more elements: 5 preceding ones each followed by a
# comma (a trailing comma before the 6th element counts, so we don't
# require a closing "]" or ")" right after the last one — real, formatted
# multi-line literals usually have one).
JS_ARRAY_OF_OBJECTS_RE = re.compile(r"\[\s*(?:\{[^{}]*\}\s*,\s*){5,}\{[^{}]*\}", re.DOTALL)
SQL_VALUES_RE = re.compile(r"\bVALUES\b((?:\s*\([^()]*\)\s*,){5,}\s*\([^()]*\))", re.IGNORECASE | re.DOTALL)


def check_literal_record_arrays_other(path: Path, text: str) -> list[Violation]:
    violations = []
    if path.suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
        if JS_ARRAY_OF_OBJECTS_RE.search(text):
            violations.append(Violation("3", path, "literal array of >5 object records"))
    if path.suffix == ".sql":
        for m in SQL_VALUES_RE.finditer(text):
            # A seed of team-chosen configuration (e.g. refresh cycles) is not
            # data, but it must say so explicitly, with a reason, inside the
            # same statement: `-- no-mock-check: config-seed <reason>`.
            stmt_start = text.rfind(";", 0, m.start()) + 1
            if SQL_CONFIG_SEED_RE.search(text[stmt_start:m.start()]):
                continue
            tuple_count = m.group(1).count("(")
            violations.append(Violation("3", path, f"SQL VALUES list with {tuple_count} tuples (>5)"))
    return violations


SQL_CONFIG_SEED_RE = re.compile(r"--[ \t]*no-mock-check:[ \t]*config-seed[ \t]+\S")


# ---- Check 4: fixtures must have a source sidecar --------------------------

def check_fixture_sidecar(path: Path, rel_parts: tuple) -> list[Violation]:
    if "fixtures" not in rel_parts:
        return []
    if path.name.endswith(".source.json"):
        return []  # the sidecar itself is not a fixture
    sidecar = path.parent / f"{path.name}.source.json"
    if not sidecar.exists():
        return [Violation("4", path, "fixture has no <file>.source.json sidecar")]
    try:
        meta = json.loads(sidecar.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return [Violation("4", sidecar, f"sidecar is not valid JSON: {exc}")]
    required = ("source_object", "byte_start", "byte_end")
    missing = [k for k in required if k not in meta]
    if missing:
        return [Violation("4", sidecar, f"sidecar missing keys: {', '.join(missing)}")]
    byte_start, byte_end = meta["byte_start"], meta["byte_end"]
    if not isinstance(byte_start, int) or not isinstance(byte_end, int) or byte_end <= byte_start:
        return [Violation("4", sidecar, "byte_start/byte_end must be integers with byte_end > byte_start")]
    actual_size = path.stat().st_size
    if byte_end - byte_start != actual_size:
        return [
            Violation(
                "4",
                sidecar,
                f"byte range spans {byte_end - byte_start} bytes but the fixture file is {actual_size} bytes",
            )
        ]
    return []


# ---- Check 6: no zero-filling ----------------------------------------------

def check_zero_filling(path: Path, text: str) -> list[Violation]:
    violations = []
    if path.suffix == ".sql" or "COALESCE" in text.upper():
        for m in COALESCE_ZERO_RE.finditer(text):
            violations.append(Violation("6", path, f"zero-fill via {m.group(0)!r}"))
    if path.suffix == ".py" or "fillna" in text:
        for m in FILLNA_ZERO_RE.finditer(text):
            violations.append(Violation("6", path, f"zero-fill via {m.group(0)!r}"))
    return violations


def scan(root: Path) -> list[Violation]:
    violations: list[Violation] = []
    any_dir_present = False
    for scan_name in SCAN_DIRS:
        if (root / scan_name).is_dir():
            any_dir_present = True
        else:
            print(f"skipped: {scan_name}/ does not exist yet")

    for path in iter_files(root):
        rel_parts = path.relative_to(root).parts
        violations.extend(check_filename(path, rel_parts))
        violations.extend(check_fixture_sidecar(path, rel_parts))

        if path.suffix not in TEXT_SUFFIXES:
            continue
        text = read_text(path)
        if text is None:
            continue

        violations.extend(check_fake_libraries(path, text))
        violations.extend(check_random(path, rel_parts, text))
        if path.suffix == ".py":
            violations.extend(check_literal_record_arrays_py(path, text))
        else:
            violations.extend(check_literal_record_arrays_other(path, text))
        violations.extend(check_zero_filling(path, text))

    if not any_dir_present:
        print("no-mock scan: nothing to scan yet (pipelines/, web/, supabase/ all absent)")

    return violations


REPO_ROOT_DEFAULT = Path(__file__).resolve().parent.parent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default=str(REPO_ROOT_DEFAULT),
        help="repo root (default: this script's repo, not the cwd)",
    )
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()

    violations = scan(root)
    if violations:
        print(f"no-mock scan: {len(violations)} violation(s):")
        for v in violations:
            print(f"  {v}")
        return 1
    print("no-mock scan: passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
