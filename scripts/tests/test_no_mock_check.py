"""Tests for scripts/no_mock_check.py.

Each test builds a small temp tree under pipelines/ web/ or supabase/ with
one offending (or clean) file, per the acceptance criterion: "fails on a
temp file importing Faker" etc. No repo fixtures are read here except the
final test, which checks the real repo passes.
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import no_mock_check as nmc  # noqa: E402


def write(root: Path, rel_path: str, content: str) -> Path:
    path = root / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


class TestRepoPasses(unittest.TestCase):
    def test_real_repo_root_passes(self):
        violations = nmc.scan(REPO_ROOT)
        self.assertEqual(
            violations, [], f"unexpected violations in real repo: {[str(v) for v in violations]}"
        )

    def test_self_and_own_tests_never_flagged(self):
        # This test file's name/path contains none of the bad tokens, but
        # exercise the guard directly for defense in depth.
        self.assertTrue(nmc.is_self(Path(__file__)))
        self.assertTrue(nmc.is_self(REPO_ROOT / "scripts" / "no_mock_check.py"))


class TestFakeLibraries(unittest.TestCase):
    def test_faker_import_in_pipelines_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/sources/bad.py", "from faker import Faker\n\ndef f():\n    return Faker()\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" and "Faker" in v.detail for v in violations))

    def test_faker_js_in_web_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "web/lib/bad.ts", "import { faker } from '@faker-js/faker';\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" for v in violations))

    def test_clean_file_passes(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/sources/good.py", "def add(a, b):\n    return a + b\n")
            violations = nmc.scan(root)
            self.assertEqual(violations, [])


class TestRandomInPipelines(unittest.TestCase):
    def test_import_random_in_pipelines_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/sources/bad.py", "import random\n\nx = random.random()\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" and "random" in v.detail for v in violations))

    def test_np_random_in_pipelines_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/sources/bad.py", "import numpy as np\n\nx = np.random.rand(3)\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" for v in violations))

    def test_random_outside_pipelines_is_ignored(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "web/scripts/gen.py", "import random\n")
            violations = nmc.scan(root)
            self.assertEqual(violations, [])


class TestFileNames(unittest.TestCase):
    def test_mock_filename_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/tests/mock_data.py", "x = 1\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" and "mock" in v.detail for v in violations))

    def test_sample_filename_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "web/lib/sample_data.ts", "export const x = 1;\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" and "sample" in v.detail for v in violations))


class TestLiteralRecordArrays(unittest.TestCase):
    def test_more_than_five_dict_rows_in_py_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = ", ".join(f'{{"id": {i}}}' for i in range(7))
            write(root, "pipelines/tests/test_thing.py", f"ROWS = [{rows}]\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" and "record array" in v.detail for v in violations))

    def test_five_or_fewer_rows_ok(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = ", ".join(f'{{"id": {i}}}' for i in range(5))
            write(root, "pipelines/tests/test_thing.py", f"ROWS = [{rows}]\n")
            violations = nmc.scan(root)
            self.assertEqual(violations, [])

    def test_sql_values_over_five_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = ", ".join(f"({i}, 'x')" for i in range(7))
            write(root, "supabase/migrations/9999_test.sql", f"insert into t values {values};\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" and "VALUES" in v.detail for v in violations))

    def test_sql_config_seed_marker_with_reason_is_allowed(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = ", ".join(f"({i}, 'x')" for i in range(7))
            write(root, "supabase/migrations/9999_test.sql",
                  f"-- no-mock-check: config-seed refresh cycles are team policy\ninsert into t values {values};\n")
            self.assertEqual(nmc.scan(root), [])

    def test_sql_config_seed_marker_without_reason_or_in_other_statement_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = ", ".join(f"({i}, 'x')" for i in range(7))
            write(root, "supabase/migrations/9999_a.sql", f"-- no-mock-check: config-seed\ninsert into t values {values};\n")
            write(root, "supabase/migrations/9999_b.sql",
                  f"-- no-mock-check: config-seed policy\nselect 1;\ninsert into t values {values};\n")
            violations = nmc.scan(root)
            self.assertEqual(sum(1 for v in violations if v.check == "3"), 2)

    def test_exactly_six_rows_is_the_boundary_fail_py(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = ", ".join(f'{{"id": {i}}}' for i in range(6))
            write(root, "pipelines/tests/test_thing.py", f"ROWS = [{rows}]\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" for v in violations))

    def test_exactly_six_tuples_is_the_boundary_fail_sql(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            values = ", ".join(f"({i}, 'x')" for i in range(6))
            write(root, "supabase/migrations/9999_test.sql", f"insert into t values {values};\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" and "VALUES" in v.detail for v in violations))

    def test_js_array_of_six_objects_with_trailing_comma_fails(self):
        # Prettier-style multi-line array literal with a trailing comma
        # after the last element must still be caught.
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = "\n  ".join(f"{{ id: {i} }}," for i in range(6))
            content = f"export const ROWS = [\n  {rows}\n];\n"
            write(root, "web/lib/rows.ts", content)
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" for v in violations))

    def test_js_array_of_five_objects_is_ok(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = "\n  ".join(f"{{ id: {i} }}," for i in range(5))
            content = f"export const ROWS = [\n  {rows}\n];\n"
            write(root, "web/lib/rows.ts", content)
            violations = nmc.scan(root)
            self.assertEqual(violations, [])


class TestFixtureSidecar(unittest.TestCase):
    def test_fixture_without_sidecar_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/tests/fixtures/eaglei/slice.csv", "a,b\n1,2\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "4" for v in violations))

    def test_fixture_with_correct_sidecar_passes(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = write(root, "pipelines/tests/fixtures/eaglei/slice.csv", "a,b\n1,2\n")
            size = fixture.stat().st_size
            sidecar = root / "pipelines/tests/fixtures/eaglei/slice.csv.source.json"
            sidecar.write_text(json.dumps({
                "source_object": "eaglei_outages_2024.csv",
                "byte_start": 1000,
                "byte_end": 1000 + size,
            }))
            violations = nmc.scan(root)
            self.assertEqual(violations, [])

    def test_fixture_sidecar_with_wrong_byte_range_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/tests/fixtures/eaglei/slice.csv", "a,b\n1,2\n")
            sidecar = root / "pipelines/tests/fixtures/eaglei/slice.csv.source.json"
            sidecar.write_text(json.dumps({
                "source_object": "eaglei_outages_2024.csv",
                "byte_start": 1000,
                "byte_end": 1001,
            }))
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "4" and "byte range" in v.detail for v in violations))


class TestZeroFilling(unittest.TestCase):
    def test_coalesce_zero_in_sql_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "supabase/migrations/9999_test.sql", "select COALESCE(outage_hours, 0) from t;\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "6" and "COALESCE" in v.detail for v in violations))

    def test_coalesce_zero_with_nested_call_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "supabase/migrations/9999_test.sql", "select COALESCE(sum(outage_hours), 0) from t;\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "6" for v in violations))

    def test_fillna_zero_in_py_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "pipelines/sources/bad.py", "df['x'] = df['x'].fillna(0)\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "6" and "fillna" in v.detail for v in violations))

    def test_coalesce_nonzero_is_fine(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "supabase/migrations/9999_test.sql", "select COALESCE(outage_hours, -1) from t;\n")
            violations = nmc.scan(root)
            self.assertEqual(violations, [])


class TestBadNameInDirectoryComponent(unittest.TestCase):
    def test_mocks_directory_with_clean_filename_fails(self):
        # Jest/Vitest convention: __mocks__/<module>.ts, where the file
        # name itself is clean but the containing directory is a mock dir.
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "web/lib/__mocks__/db.ts", "export const db = {};\n")
            violations = nmc.scan(root)
            self.assertTrue(any(v.check == "3" for v in violations))


class TestDefaultRootIsRepoNotCwd(unittest.TestCase):
    def test_default_root_resolves_to_repo_root_regardless_of_cwd(self):
        import os

        original_cwd = os.getcwd()
        try:
            os.chdir(str(REPO_ROOT / "scripts"))
            exit_code = nmc.main([])
        finally:
            os.chdir(original_cwd)
        # The real repo has no violations, so this must still exit 0 even
        # though cwd is not the repo root.
        self.assertEqual(exit_code, 0)


class TestGeneratedDirsSkipped(unittest.TestCase):
    def test_node_modules_is_never_scanned(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(root, "web/node_modules/@faker-js/faker/index.js", "module.exports = {};\n")
            write(root, "web/node_modules/some-pkg/mock-server.js", "x = 1;\n")
            violations = nmc.scan(root)
            self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
