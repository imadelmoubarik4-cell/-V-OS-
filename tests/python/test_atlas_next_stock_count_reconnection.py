from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
HTML = (ROOT / "apps/web/next.html").read_text()
BRIDGE = (ROOT / "apps/web/assets/js/atlas-next-gateway-bridge.js").read_text()
COUNTS = (ROOT / "apps/web/assets/js/atlas-next-stock-counts.js").read_text()
STYLES = (ROOT / "apps/web/assets/css/atlas-next-stock-counts.css").read_text()


class AtlasNextStockCountReconnectionTests(unittest.TestCase):
    def test_assets_load_after_the_existing_dependencies(self):
        self.assertIn("atlas-next-stock-counts.css", HTML)
        bridge_index = HTML.index("atlas-next-gateway-bridge.js")
        core_index = HTML.index("assets/js/atlas-next.js")
        counts_index = HTML.index("atlas-next-stock-counts.js")
        self.assertLess(bridge_index, core_index)
        self.assertLess(core_index, counts_index)
        self.assertEqual(HTML.count('id="auth-screen"'), 1)
        self.assertEqual(HTML.count('id="app-shell"'), 1)

    def test_gateway_uses_the_existing_auth_session(self):
        self.assertIn("dnefgcmjcgxlynycxkts.supabase.co", BRIDGE)
        self.assertIn("uhbamqetppqmygesoeeh.supabase.co", BRIDGE)
        self.assertIn("client.auth.getSession()", BRIDGE)
        self.assertIn("Bearer ${session.access_token}", BRIDGE)
        self.assertIn("supabase.createClient = originalCreateClient", BRIDGE)
        for forbidden in ("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_", "atlas_private"):
            self.assertNotIn(forbidden, BRIDGE)

    def test_l1_calls_only_the_existing_gateway(self):
        self.assertIn("atlas-stock-counts", COUNTS)
        self.assertIn("AtlasGatewayBridge.request", COUNTS)
        for action in (
            "snapshot", "detail", "start", "save-line", "submit", "verify",
            "reject", "cancel", "prepare-publication", "publish",
        ):
            self.assertRegex(COUNTS, rf"['\"]{re.escape(action)}['\"]")
        self.assertIsNone(re.search(r"(?:client|supabase|sb|atlasSupabase)\s*\.\s*(?:from|rpc)\s*\(", COUNTS))
        for forbidden in ("atlas_private", "inventory_items", "service_role"):
            self.assertNotIn(forbidden, COUNTS)

    def test_original_unit_evidence_is_preserved(self):
        for unit in ("bottle", "case", "unit", "litre", "millilitre", "kilogram", "gram"):
            self.assertIn(f"{unit}:", COUNTS)
        for token in (
            "observed_input_quantity", "observed_input_unit", "supported_count_units",
            "capture_surface: 'atlas_next_count_line'", "client_recorded_at",
        ):
            self.assertIn(token, COUNTS)

    def test_publication_is_explicit_and_double_gated(self):
        self.assertIn("publication_environment_enabled", COUNTS)
        self.assertIn("production_apply_enabled", COUNTS)
        self.assertIn("Prepare publication", COUNTS)
        self.assertIn("Publish verified count", COUNTS)
        self.assertIn("window.confirm", COUNTS)

    def test_scanner_is_not_bundled_into_l1(self):
        for forbidden in ("navigator.mediaDevices", "BarcodeDetector", "getUserMedia", "decodeFromVideoDevice"):
            self.assertNotIn(forbidden, COUNTS)
        self.assertIn('[data-action="start-count"]', COUNTS)
        self.assertIn('[data-service-action="count"]', COUNTS)

    def test_no_observer_or_polling_renderer_is_added(self):
        combined = BRIDGE + "\n" + COUNTS
        self.assertNotIn("MutationObserver", combined)
        self.assertIsNone(re.search(r"\bsetInterval\s*\(", combined))
        self.assertIn("@media (max-width: 760px)", STYLES)
        self.assertIn("@media (max-width: 600px)", STYLES)
        self.assertNotIn("Fraunces", STYLES)
        self.assertNotIn("IBM Plex", STYLES)


if __name__ == "__main__":
    unittest.main()
