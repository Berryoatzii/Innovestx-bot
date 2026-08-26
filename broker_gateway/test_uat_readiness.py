import tempfile
import unittest
from io import BytesIO, TextIOWrapper
from pathlib import Path

from uat_readiness import configure_utf8_output, inspect_local_readiness


class UatReadinessTests(unittest.TestCase):
    def test_missing_credentials_explains_setup_without_exposing_values(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = inspect_local_readiness(root, root / "home")

        self.assertEqual(result["stage"], "SETUP_REQUIRED")
        self.assertEqual(result["realMoney"], "REAL-NO-GO")
        self.assertIn("ยังไม่มีข้อมูล Settrade UAT", result["blockers"])

    def test_valid_local_uat_configuration_is_read_only_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home = root / "home"
            (root / ".venv" / "Scripts").mkdir(parents=True)
            (root / ".venv" / "Scripts" / "python.exe").write_text("", encoding="utf-8")
            (root / ".env").write_text(
                "\n".join([
                    "BROKER_ENVIRONMENT=uat",
                    "SETTRADE_APP_ID=private-app-id",
                    "SETTRADE_APP_SECRET=private-app-secret",
                    "SETTRADE_APP_CODE=ALGO_EQ",
                    "SETTRADE_ACCOUNT_NO=private-account",
                    "SETTRADE_PIN=123456",
                    "BROKER_GATEWAY_TOKEN=private-token-that-must-not-leak",
                    "BROKER_GATEWAY_HOST=127.0.0.1",
                    "BROKER_PRODUCTION_ENABLED=false",
                ]),
                encoding="utf-8",
            )
            (home / "AppData").mkdir(parents=True)
            (home / "AppData" / "settradesdkv2_config.txt").write_text(
                "environment=uat\nclear_log=30\n", encoding="utf-8"
            )

            result = inspect_local_readiness(root, home)

        self.assertEqual(result["stage"], "UAT_CONFIGURED")
        self.assertEqual(result["environment"], "uat")
        self.assertEqual(result["realMoney"], "REAL-NO-GO")
        serialized = str(result)
        self.assertNotIn("private-app-secret", serialized)
        self.assertNotIn("private-account", serialized)
        self.assertNotIn("123456", serialized)
        self.assertNotIn("private-token", serialized)

    def test_production_selector_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home = root / "home"
            (root / ".venv" / "Scripts").mkdir(parents=True)
            (root / ".venv" / "Scripts" / "python.exe").write_text("", encoding="utf-8")
            (root / ".env").write_text(
                "BROKER_ENVIRONMENT=uat\nBROKER_GATEWAY_HOST=127.0.0.1\n",
                encoding="utf-8",
            )
            (home / "AppData").mkdir(parents=True)
            (home / "AppData" / "settradesdkv2_config.txt").write_text(
                "environment=prod\n", encoding="utf-8"
            )

            result = inspect_local_readiness(root, home)

        self.assertEqual(result["stage"], "BLOCKED")
        self.assertIn("SDK ไม่ได้ตั้งเป็น UAT", result["blockers"])

    def test_windows_legacy_console_is_switched_to_utf8(self):
        raw = BytesIO()
        stream = TextIOWrapper(raw, encoding="cp1252")
        configure_utf8_output(stream)
        stream.write("รายงานความพร้อม")
        stream.flush()
        self.assertIn("รายงานความพร้อม", raw.getvalue().decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
