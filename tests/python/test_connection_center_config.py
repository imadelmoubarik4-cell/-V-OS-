from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONFIG = (ROOT / "apps/web/config.js").read_text()


class ConnectionCenterConfigTests(unittest.TestCase):
    def test_connection_center_has_an_explicit_isolated_gateway(self):
        self.assertIn(
            'CONNECTIONS_API: "https://uhbamqetppqmygesoeeh.supabase.co/functions/v1/atlas-connections"',
            CONFIG,
        )
        self.assertNotIn(
            'CONNECTIONS_API: "https://dnefgcmjcgxlynycxkts.supabase.co',
            CONFIG,
        )


if __name__ == "__main__":
    unittest.main()
