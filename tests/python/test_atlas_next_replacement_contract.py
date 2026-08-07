from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
HTML = (ROOT / "apps/web/next.html").read_text()
CSS = (ROOT / "apps/web/assets/css/atlas-next.css").read_text()
APP = (ROOT / "apps/web/assets/js/atlas-next.js").read_text()
COMBINED = "\n".join((HTML, CSS, APP))


class AtlasNextReplacementContract(unittest.TestCase):
    def test_single_auth_and_application_tree(self):
        self.assertEqual(HTML.count('id="auth-screen"'), 1)
        self.assertEqual(HTML.count('id="app-shell"'), 1)
        self.assertEqual(HTML.count('id="atlas-boot"'), 1)
        self.assertNotIn('id="login-screen"', HTML)
        self.assertNotIn("phase4-shell.js", HTML)
        self.assertNotIn("phase4-operations.js", HTML)

    def test_boot_and_requests_are_bounded(self):
        self.assertIn("bootTimeoutMs: 15000", APP)
        self.assertIn("requestTimeoutMs: 12000", APP)
        self.assertIn("withTimeout(", APP)
        self.assertIn("state.bootFinished = true", APP)
        self.assertIn("showAuth(", APP)

    def test_no_observer_or_polling_renderer(self):
        self.assertNotIn("MutationObserver", APP)
        self.assertIsNone(re.search(r"\bsetInterval\s*\(", APP))

    def test_initial_runtime_is_read_only(self):
        self.assertIn(".from('profiles').select", APP)
        self.assertIn(".from('inventory_items').select", APP)
        for forbidden in (
            ".insert(",
            ".update(",
            ".delete(",
            ".upsert(",
            ".rpc(",
            "adjust_inventory",
        ):
            self.assertNotIn(forbidden, APP)

    def test_design_runtime_and_private_credentials_are_absent(self):
        for forbidden in (
            "<x-dc",
            "support.js",
            "Babel.transform",
            "ReactDOM",
            "SUPABASE_SERVICE_ROLE_KEY",
            "service_role",
        ):
            self.assertNotIn(forbidden, COMBINED)
        self.assertIsNone(re.search(r"\bnew\s+Function\s*\(", COMBINED))

    def test_design_tokens_and_responsive_contract(self):
        for token in ("#f6f6f4", "#1fa8a0", "#111113", "#3fc7be"):
            self.assertIn(token, CSS.lower())
        self.assertIn('@media (max-width: 760px)', CSS)
        self.assertIn('prefers-reduced-motion', CSS)
        self.assertIn(':focus-visible', CSS)

    def test_normal_inventory_is_not_editable(self):
        for forbidden in ("qty-input", "step-btn", "data-line-step"):
            self.assertNotIn(forbidden, HTML)
        self.assertIn("Controlled inventory boundary", HTML)
        self.assertIn("No stock change was performed", APP)


if __name__ == "__main__":
    unittest.main()
