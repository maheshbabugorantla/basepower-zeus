"""Validate .claude/agents/*.md frontmatter and the real-data instruction
block, per M0-D0's acceptance criteria:

- `claude --agent orchestrator` loads and lists the roster: we verify this
  statically by parsing every agent file's frontmatter (name, description,
  tools, model where applicable) rather than launching an interactive
  `claude` session, and by checking the orchestrator's tools line names
  exactly the five roster agents.
- CLAUDE.md and .claude/agents/web-dev.md both require reading DESIGN.md
  and PRODUCT.md before UI work.
"""
import re
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_DIR = REPO_ROOT / ".claude" / "agents"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
import dag  # noqa: E402  (reuse the same frontmatter parser as dag.py)

ROSTER_NAMES = {"schema-dev", "pipeline-dev", "web-dev", "platform-dev", "verifier"}

INSTRUCTION_BLOCK = (
    "Never generate synthetic, sample, mock, or placeholder data, including in tests.\n"
    "Only load data that comes from a raw file with an ops.source_manifest row.\n"
    "If a needed source is missing or fails to download, stop and report it. Do not substitute values.\n"
    "Edit only your ticket's owns paths. Build the thinnest slice that fills its contract_out, then run its Acceptance commands."
)


def read_frontmatter_and_body(path: Path):
    text = path.read_text()
    fields = dag.parse_frontmatter(text)
    # Body is everything after the second '---' line.
    lines = text.splitlines()
    end = None
    dash_count = 0
    for i, line in enumerate(lines):
        if line.strip() == "---":
            dash_count += 1
            if dash_count == 2:
                end = i
                break
    body = "\n".join(lines[(end + 1):]) if end is not None else text
    return fields, body


class TestRosterFilesExist(unittest.TestCase):
    def test_all_roster_and_orchestrator_files_exist(self):
        expected = ROSTER_NAMES | {"orchestrator"}
        found = {p.stem for p in AGENTS_DIR.glob("*.md")}
        self.assertEqual(expected, found)


class TestRosterFrontmatter(unittest.TestCase):
    def test_each_roster_agent_pins_sonnet_5(self):
        for name in ROSTER_NAMES:
            fields, _ = read_frontmatter_and_body(AGENTS_DIR / f"{name}.md")
            self.assertEqual(fields.get("model"), "claude-sonnet-5", name)

    def test_each_roster_agent_has_name_description_tools(self):
        for name in ROSTER_NAMES:
            fields, _ = read_frontmatter_and_body(AGENTS_DIR / f"{name}.md")
            self.assertEqual(fields.get("name"), name)
            self.assertTrue(fields.get("description"))
            self.assertTrue(fields.get("tools"))

    def test_builder_agents_use_worktree_isolation(self):
        builders = ROSTER_NAMES - {"verifier"}
        for name in builders:
            fields, _ = read_frontmatter_and_body(AGENTS_DIR / f"{name}.md")
            self.assertEqual(fields.get("isolation"), "worktree", name)

    def test_verifier_has_no_isolation_and_readonly_tools(self):
        fields, _ = read_frontmatter_and_body(AGENTS_DIR / "verifier.md")
        self.assertNotIn("isolation", fields)
        tools = {t.strip() for t in fields.get("tools", "").split(",")}
        self.assertEqual(tools, {"Read", "Grep", "Glob", "Bash"})

    def test_each_roster_agent_carries_instruction_block(self):
        for name in ROSTER_NAMES:
            _, body = read_frontmatter_and_body(AGENTS_DIR / f"{name}.md")
            self.assertIn(INSTRUCTION_BLOCK, body, f"{name}.md missing the instruction block")


class TestOrchestrator(unittest.TestCase):
    def test_orchestrator_tools_line_names_exact_roster(self):
        text = (AGENTS_DIR / "orchestrator.md").read_text()
        m = re.search(r"tools:\s*Agent\(([^)]*)\)", text)
        self.assertIsNotNone(m, "orchestrator.md must declare Agent(<roster>) in its tools: line")
        named = {n.strip() for n in m.group(1).split(",")}
        self.assertEqual(named, ROSTER_NAMES)

    def test_orchestrator_has_name_and_description(self):
        fields, _ = read_frontmatter_and_body(AGENTS_DIR / "orchestrator.md")
        self.assertEqual(fields.get("name"), "orchestrator")
        self.assertTrue(fields.get("description"))


class TestDesignReadingRequirement(unittest.TestCase):
    def test_claude_md_requires_design_and_product(self):
        text = (REPO_ROOT / "CLAUDE.md").read_text()
        self.assertIn("DESIGN.md", text)
        self.assertIn("PRODUCT.md", text)

    def test_web_dev_requires_design_and_product(self):
        text = (AGENTS_DIR / "web-dev.md").read_text()
        self.assertIn("DESIGN.md", text)
        self.assertIn("PRODUCT.md", text)

    def test_claude_md_carries_instruction_block(self):
        text = (REPO_ROOT / "CLAUDE.md").read_text()
        self.assertIn(INSTRUCTION_BLOCK, text)


class TestNoSecretsLeaked(unittest.TestCase):
    """Platform facts in CLAUDE.md must be names/behavior only, never values."""

    def test_no_secret_looking_values_in_claude_md(self):
        text = (REPO_ROOT / "CLAUDE.md").read_text()
        self.assertIsNone(re.search(r"sb_secret_[A-Za-z0-9]", text))
        self.assertIsNone(re.search(r"postgres(?:ql)?://\S+:\S+@", text))
        self.assertNotIn("/Users/", text)


class TestSettingsJson(unittest.TestCase):
    def test_subagent_model_env_pinned(self):
        import json

        data = json.loads((REPO_ROOT / ".claude" / "settings.json").read_text())
        self.assertEqual(data["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "claude-sonnet-5")
        self.assertEqual(str(data["env"]["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]), "1")


if __name__ == "__main__":
    unittest.main()
