from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
NEXT_HTML = (ROOT / "apps/web/next.html").read_text()
LOGIN_HTML = (ROOT / "apps/web/login.html").read_text()
LOGIN_JS = (ROOT / "apps/web/assets/js/atlas-login.js").read_text()
BRIDGE = (ROOT / "apps/web/assets/js/atlas-next-gateway-bridge.js").read_text()


class AtlasDesignRecoveryContract(unittest.TestCase):
    def test_polished_single_shell_is_restored(self):
        self.assertEqual(NEXT_HTML.count('id="app-shell"'), 1)
        self.assertIn("assets/css/atlas-next.css", NEXT_HTML)
        self.assertIn("assets/css/atlas-next-stock-counts.css", NEXT_HTML)
        self.assertIn("assets/js/atlas-next-stock-counts.js", NEXT_HTML)
        for forbidden in (
            "atlas-next-workspaces",
            "atlas-next-purchasing",
            "recipes.css",
            "recipes.js",
            "app.html",
            "Recipe Intelligence",
            "Atlas Alpha 0.3",
        ):
            self.assertNotIn(forbidden, NEXT_HTML)

    def test_login_isolated_from_workspace_renderers(self):
        self.assertEqual(LOGIN_HTML.count('id="login-screen"'), 1)
        self.assertIn("assets/js/atlas-login.js", LOGIN_HTML)
        self.assertIn("@supabase/supabase-js", LOGIN_HTML)
        for forbidden in (
            "atlas-next-workspaces",
            "atlas-next-purchasing",
            "inventory-scanner",
            "item-master-workspace",
            "recipes.js",
            "operations-checkpoint",
            "team-messages",
            "brain.js",
        ):
            self.assertNotIn(forbidden, LOGIN_HTML)

    def test_login_handoff_is_bounded_and_direct(self):
        self.assertIn("new URL('next.html', window.location.href)", LOGIN_JS)
        self.assertNotIn("new URL('app.html'", LOGIN_JS)
        self.assertIn("requestTimeoutMs: 12000", LOGIN_JS)
        self.assertIn("sessionTimeoutMs: 15000", LOGIN_JS)
        self.assertIn("signOutTimeoutMs: 4000", LOGIN_JS)
        self.assertIn("force_signout", LOGIN_JS)
        self.assertIn(".from('profiles').select", LOGIN_JS)

    def test_gateway_contract_is_preserved(self):
        self.assertIn("RECOVERY_TIMEOUT_MS = 18000", BRIDGE)
        self.assertIn("redirectToLogin", BRIDGE)
        self.assertIn("MutationObserver", BRIDGE)
        self.assertIn("force_signout", BRIDGE)
        self.assertIn("window.AtlasGatewayBridge = Object.freeze", BRIDGE)
        self.assertIn("GATEWAY_HOST = 'uhbamqetppqmygesoeeh.supabase.co'", BRIDGE)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", BRIDGE)
        self.assertNotIn("service_role", BRIDGE)


if __name__ == "__main__":
    unittest.main()
