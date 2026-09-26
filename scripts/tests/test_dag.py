"""Tests for scripts/dag.py.

Real ticket files from tickets/M0/ and tickets/T0/ are copied into a temp
dir and, for the failure cases, edited there. No invented ticket fixtures.
"""
import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import dag  # noqa: E402


ALL_MILESTONES = ("T0", "M0", "M1", "M2", "M3", "M4", "M5")


def copy_real_tickets(dest_root: Path) -> Path:
    """Copy tickets/M0 and tickets/T0 into dest_root; return the M0 dir."""
    for milestone in ("M0", "T0"):
        src = REPO_ROOT / "tickets" / milestone
        dst = dest_root / "tickets" / milestone
        shutil.copytree(src, dst)
    return dest_root / "tickets" / "M0"


def copy_all_real_tickets(dest_root: Path) -> Path:
    for milestone in ALL_MILESTONES:
        src = REPO_ROOT / "tickets" / milestone
        if src.is_dir():
            shutil.copytree(src, dest_root / "tickets" / milestone)
    return dest_root / "tickets"


class TestRealGraph(unittest.TestCase):
    def test_m0_waves_match_expected(self):
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            tickets = dag.load_tickets(m0_dir)
            waves, external = dag.compute_waves(tickets, m0_dir.parent, set())
            self.assertEqual(
                dag.format_waves(waves), "D0 | D1,S1 | P2,W0 | P1,W1,W2 | V1"
            )
            # T0-H1 is external and satisfied (status: done in the real file)
            self.assertIn(("T0-H1", True, "status: done"), external["M0-D0"])

    def test_main_prints_expected_line(self):
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            buf = []
            import io
            import contextlib

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = dag.main([str(m0_dir)])
            self.assertEqual(exit_code, 0)
            self.assertIn("D0 | D1,S1 | P2,W0 | P1,W1,W2 | V1", stdout.getvalue())


class TestCycle(unittest.TestCase):
    def test_cycle_among_real_tickets_fails(self):
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            d0 = m0_dir / "M0-D0.md"
            text = d0.read_text()
            # M0-D0 currently depends only on the external T0-H1. Make it
            # also depend on M0-V1 (which transitively depends on M0-D0),
            # creating a real cycle.
            text = text.replace(
                "depends_on: [T0-H1]", "depends_on: [T0-H1, M0-V1]"
            )
            d0.write_text(text)

            tickets = dag.load_tickets(m0_dir)
            with self.assertRaises(dag.CycleError):
                dag.compute_waves(tickets, m0_dir.parent, set())

    def test_main_exits_nonzero_on_cycle(self):
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            d0 = m0_dir / "M0-D0.md"
            d0.write_text(
                d0.read_text().replace(
                    "depends_on: [T0-H1]", "depends_on: [T0-H1, M0-V1]"
                )
            )
            exit_code = dag.main([str(m0_dir)])
            self.assertEqual(exit_code, 1)


class TestOwnsOverlap(unittest.TestCase):
    def test_equal_path_overlap_in_same_wave_fails(self):
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            # M0-D1 and M0-S1 are both in wave 2. Give S1 the exact same
            # owns path as D1 to force an equal-path overlap in one wave.
            s1 = m0_dir / "M0-S1.md"
            text = s1.read_text()
            self.assertIn("owns: [supabase/migrations/0001_m0.sql]", text)
            text = text.replace(
                "owns: [supabase/migrations/0001_m0.sql]",
                "owns: [supabase/migrations/0001_m0.sql, web/app/layout.tsx]",
            )
            s1.write_text(text)

            tickets = dag.load_tickets(m0_dir)
            with self.assertRaises(dag.OwnsOverlapError):
                dag.compute_waves(tickets, m0_dir.parent, set())

    def test_nested_directory_overlap_in_same_wave_fails(self):
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            # M0-D1 owns web/app/layout.tsx (a file). Give same-wave M0-S1
            # ownership of the containing directory web/app/ to force a
            # nested overlap.
            s1 = m0_dir / "M0-S1.md"
            text = s1.read_text()
            text = text.replace(
                "owns: [supabase/migrations/0001_m0.sql]",
                "owns: [supabase/migrations/0001_m0.sql, web/app/]",
            )
            s1.write_text(text)

            tickets = dag.load_tickets(m0_dir)
            with self.assertRaises(dag.OwnsOverlapError):
                dag.compute_waves(tickets, m0_dir.parent, set())

    def test_cross_wave_overlap_is_allowed(self):
        # The real graph has M0-D1 (wave 2) and M0-W2 (wave 4) both owning
        # web/app/layout.tsx. That must NOT raise, since they are in
        # different waves.
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            tickets = dag.load_tickets(m0_dir)
            waves, _ = dag.compute_waves(tickets, m0_dir.parent, set())
            self.assertEqual(
                dag.format_waves(waves), "D0 | D1,S1 | P2,W0 | P1,W1,W2 | V1"
            )


class TestUnknownDependency(unittest.TestCase):
    def test_unknown_internal_dependency_fails(self):
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            d1 = m0_dir / "M0-D1.md"
            d1.write_text(
                d1.read_text().replace(
                    "depends_on: [M0-D0]", "depends_on: [M0-D0, M0-X9]"
                )
            )
            tickets = dag.load_tickets(m0_dir)
            with self.assertRaises(dag.UnknownDependencyError):
                dag.compute_waves(tickets, m0_dir.parent, set())

    def test_unknown_external_dependency_fails(self):
        # A mistyped external id (no matching file anywhere under
        # tickets_root) must fail loudly, not be silently treated as
        # satisfied-by-prior-milestone.
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            d0 = m0_dir / "M0-D0.md"
            d0.write_text(
                d0.read_text().replace(
                    "depends_on: [T0-H1]", "depends_on: [T0-H9]"
                )
            )
            tickets = dag.load_tickets(m0_dir)
            with self.assertRaises(dag.UnknownDependencyError):
                dag.compute_waves(tickets, m0_dir.parent, set())

    def test_real_t0_h1_external_dependency_resolves(self):
        # Sanity check against the real T0-H1.md: it exists and is
        # status: done, so it must resolve rather than raise.
        with TemporaryDirectory() as tmp:
            m0_dir = copy_real_tickets(Path(tmp))
            tickets = dag.load_tickets(m0_dir)
            waves, external = dag.compute_waves(tickets, m0_dir.parent, set())
            self.assertEqual(waves[0], ["M0-D0"])


class TestAllMilestonesParseCleanly(unittest.TestCase):
    """dag.py must parse the real files in every tickets/<Mn>/, not just M0
    (the orchestrator runs it on M1-M5 too)."""

    def test_every_real_milestone_computes_waves_without_error(self):
        with TemporaryDirectory() as tmp:
            tickets_root = copy_all_real_tickets(Path(tmp))
            for milestone in ALL_MILESTONES:
                m_dir = tickets_root / milestone
                if not m_dir.is_dir():
                    continue
                with self.subTest(milestone=milestone):
                    tickets = dag.load_tickets(m_dir)
                    waves, _ = dag.compute_waves(tickets, tickets_root, set())
                    all_ids = {tid for wave in waves for tid in wave}
                    self.assertEqual(all_ids, set(tickets.keys()))


class TestPathsOverlap(unittest.TestCase):
    def test_equal(self):
        self.assertTrue(dag.paths_overlap("a/b.py", "a/b.py"))

    def test_directory_contains_file(self):
        self.assertTrue(dag.paths_overlap("a/", "a/b.py"))
        self.assertTrue(dag.paths_overlap("a/b.py", "a/"))

    def test_sibling_files_do_not_overlap(self):
        self.assertFalse(dag.paths_overlap("a/b.py", "a/c.py"))

    def test_similarly_prefixed_dirs_do_not_falsely_overlap(self):
        # web/tests/m0/ and web/tests/m0-shell/ must NOT overlap even though
        # one string is a textual prefix of a component of the other.
        self.assertFalse(dag.paths_overlap("web/tests/m0/", "web/tests/m0-shell/"))


if __name__ == "__main__":
    unittest.main()
