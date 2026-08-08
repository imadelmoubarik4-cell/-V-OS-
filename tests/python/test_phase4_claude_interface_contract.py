from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
INDEX = (ROOT / "apps/web/index.html").read_text()
ENTRY = (ROOT / "apps/web/assets/js/phase4-entry.js").read_text()
SHELL = (ROOT / "apps/web/assets/js/phase4-shell.js").read_text()
OPERATIONS = (ROOT / "apps/web/assets/js/phase4-operations.js").read_text()
CSS = (ROOT / "apps/web/assets/css/phase4-claude.css").read_text()
MODAL = (ROOT / "apps/web/assets/js/modal.js").read_text()
RELEASE = (ROOT / "releases/alpha-0.9.0/PHASE4_CLAUDE_INTERFACE_MIGRATION.md").read_text()


class Phase4ClaudeInterfaceContract(unittest.TestCase):
    def test_claude_is_the_native_first_paint(self):
        self.assertRegex(INDEX, r'<html[^>]+data-atlas-phase=["\']4["\']')
        self.assertRegex(INDEX, r'<body class=["\'][^"\']*atlas-phase4[^"\']*atlas-native-ui')
        self.assertIn("assets/css/phase4-claude.css", INDEX)
        self.assertIn("assets/css/phase4-operations.css", INDEX)
        self.assertIn("assets/js/phase4-entry.js", INDEX)
        self.assertIn("await window.ensureAtlasInterface?.();", INDEX)

    def test_one_entry_point_mounts_shell_and_operations_before_app_reveal(self):
        self.assertIn("assets/js/phase4-shell.js", ENTRY)
        self.assertIn("assets/js/phase4-operations.js", ENTRY)
        self.assertIn("await loadScriptOnce(SHELL_SRC", ENTRY)
        self.assertIn("await loadScriptOnce(OPERATIONS_SRC", ENTRY)
        self.assertIn("window.ensureAtlasInterface", ENTRY)
        self.assertIn("atlas:interface-ready", ENTRY)
        self.assertNotIn("phase4-shell.js", MODAL)
        self.assertNotIn("phase4-operations", MODAL)

    def test_navigation_preserves_current_operational_workspaces(self):
        for value in (
            "Home",
            "Operations",
            "Inventory",
            "Recipes",
            "Purchasing",
            "Import Center",
            "Real VÁ Data",
            "Marketing",
            "Messages",
            "Team",
            "Profiles",
            "Shifts",
            "Knowledge",
            "Atlas Brain",
            "Business Intelligence",
            "Reports",
            "Settings",
            "System",
        ):
            self.assertIn(value, SHELL)
        self.assertIn("MORE", SHELL)
        self.assertIn("remaining.forEach", SHELL)
        self.assertIn("nav.replaceChildren(fragment)", SHELL)

    def test_presentation_has_no_dom_reconciliation_loop(self):
        self.assertNotIn("MutationObserver", SHELL)
        self.assertNotRegex(SHELL, r"setInterval\s*\(")
        self.assertNotIn("MutationObserver", OPERATIONS)
        self.assertNotRegex(OPERATIONS, r"setInterval\s*\(")

    def test_visual_tokens_match_the_approved_claude_direction(self):
        for token in ("#f6f6f4", "#1fa8a0", "#111113", "#3fc7be"):
            self.assertIn(token, CSS.lower())
        self.assertRegex(CSS, r"font-family:\s*Inter")
        self.assertIn('data-atlas-theme="dark"', CSS)
        self.assertIn("prefers-reduced-motion", CSS)

    def test_legacy_global_fab_is_removed(self):
        self.assertRegex(CSS, r"\.fab-wrap\s*\{\s*display:\s*none\s*!important")

    def test_design_runtime_and_private_credentials_are_not_shipped(self):
        joined = "\n".join((ENTRY, SHELL, OPERATIONS, CSS, MODAL))
        for forbidden in (
            "support.js",
            "<x-dc",
            "Babel.transform",
            "ReactDOM",
            "SUPABASE_SERVICE_ROLE_KEY",
        ):
            self.assertNotIn(forbidden, joined)
        self.assertIsNone(re.search(r"\bnew\s+Function\s*\(", joined))

    def test_release_record_keeps_production_and_approval_boundaries(self):
        self.assertIn("does not authorize merge, production migration or release", RELEASE)
        for phrase in (
            "modify a database schema or migration",
            "change live stock",
            "publish a count",
            "create or submit a supplier order",
            "publish social content",
        ):
            self.assertIn(f"- {phrase};", RELEASE)


if __name__ == "__main__":
    unittest.main()
