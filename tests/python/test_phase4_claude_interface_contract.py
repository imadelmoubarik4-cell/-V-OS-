from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
SHELL = (ROOT / "apps/web/assets/js/phase4-shell.js").read_text()
CSS = (ROOT / "apps/web/assets/css/phase4-claude.css").read_text()
MODAL = (ROOT / "apps/web/assets/js/modal.js").read_text()
RELEASE = (ROOT / "releases/alpha-0.9.0/PHASE4_CLAUDE_INTERFACE_MIGRATION.md").read_text()


class Phase4ClaudeInterfaceContract(unittest.TestCase):
    def test_shell_mounts_only_after_the_verified_profile(self):
        self.assertIn("assets/js/phase4-shell.js", MODAL)
        self.assertIn("atlas:profile-ready", MODAL)
        self.assertIn("window.atlasCurrentProfile?.active", MODAL)
        self.assertNotIn("phase4-operations-bootstrap.js", MODAL)
        self.assertIn("assets/css/phase4-claude.css", SHELL)
        self.assertIn("window.AtlasPhase4Shell", SHELL)
        self.assertIn("atlas:phase4-ready", SHELL)

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

    def test_shell_has_no_dom_reconciliation_loop(self):
        self.assertNotIn("MutationObserver", SHELL)
        self.assertNotRegex(SHELL, r"setInterval\s*\(")
        self.assertNotIn("phase4-operations-bootstrap.js", MODAL)

    def test_visual_tokens_match_the_approved_claude_direction(self):
        for token in ("#f6f6f4", "#1fa8a0", "#111113", "#3fc7be"):
            self.assertIn(token, CSS.lower())
        self.assertRegex(CSS, r"font-family:\s*Inter")
        self.assertIn('data-atlas-theme="dark"', CSS)
        self.assertIn("prefers-reduced-motion", CSS)

    def test_legacy_global_fab_is_removed(self):
        self.assertRegex(CSS, r"\.fab-wrap\s*\{\s*display:\s*none\s*!important")

    def test_design_runtime_and_private_credentials_are_not_shipped(self):
        joined = "\n".join((SHELL, CSS, MODAL))
        for forbidden in (
            "support.js",
            "<x-dc",
            "Babel.transform",
            "ReactDOM",
            "SUPABASE_SERVICE_ROLE_KEY",
            "adjust_inventory",
        ):
            self.assertNotIn(forbidden, joined)
        self.assertIsNone(re.search(r"\bnew\s+Function\s*\(", joined))
        self.assertIsNone(re.search(r"(?<!Array)\.from\s*\(", joined))

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
