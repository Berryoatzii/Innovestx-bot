import unittest

from lock_uat_controls import locked_lines


class LockUatControlsTests(unittest.TestCase):
    def test_locks_only_known_uat_controls_and_preserves_secrets(self):
        original = [
            "BROKER_ENVIRONMENT=uat",
            "SETTRADE_APP_SECRET=private-secret",
            "BROKER_CASH_FIELD=",
            "BROKER_REQUIRED_ACCOUNT_TYPE=",
            "BROKER_PRODUCTION_ENABLED=false",
        ]
        result = locked_lines(original)
        self.assertIn("SETTRADE_APP_SECRET=private-secret", result)
        self.assertIn("BROKER_CASH_FIELD=cashBalance", result)
        self.assertIn("BROKER_REQUIRED_ACCOUNT_TYPE=CASH_ACCOUNT", result)

    def test_refuses_production_or_conflicting_schema(self):
        with self.assertRaisesRegex(RuntimeError, "UAT_ONLY"):
            locked_lines(["BROKER_ENVIRONMENT=prod", "BROKER_PRODUCTION_ENABLED=false"])
        with self.assertRaisesRegex(RuntimeError, "BROKER_CASH_FIELD_CONFLICT"):
            locked_lines([
                "BROKER_ENVIRONMENT=uat",
                "BROKER_PRODUCTION_ENABLED=false",
                "BROKER_CASH_FIELD=buyingPower",
            ])


if __name__ == "__main__":
    unittest.main()
