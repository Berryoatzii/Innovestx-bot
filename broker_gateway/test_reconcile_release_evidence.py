import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reconcile_release_evidence import reconcile


class ReconcileReleaseEvidenceTests(unittest.TestCase):
    def write_json(self, folder: Path, name: str, value: dict) -> Path:
        path = folder / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_promotes_only_verified_observation_gates(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            uat = self.write_json(folder, "uat.json", {
                "environment": "uat", "complete": True, "duplicateProtected": True,
                "cancellationVerified": True, "matchedQuantity": 0,
                "readbackClassification": "TERMINAL_CANCELLED_NO_FILL",
                "realMoney": "REAL-NO-GO",
            })
            prod = self.write_json(folder, "prod.json", {
                "testedAt": "2026-08-26T07:46:39+00:00", "environment": "prod",
                "readOnly": True, "productionEnabled": False, "gatewayHost": "loopback",
                "cashVerified": True, "cashField": "cashBalance", "ordersCount": 0,
                "unresolvedCount": 0,
            })
            with patch("reconcile_release_evidence.datetime") as clock:
                clock.now.return_value = __import__("datetime").datetime(2026, 8, 26, 8, 0, tzinfo=__import__("datetime").timezone.utc)
                clock.fromisoformat.side_effect = __import__("datetime").datetime.fromisoformat
                result = reconcile({"strategyReleaseApproved": False}, uat, prod)

            self.assertTrue(result["uatOrderCycleComplete"])
            self.assertTrue(result["productionReadOnlyVerified"])
            self.assertTrue(result["zeroUnresolvedVerified"])
            self.assertFalse(result["strategyReleaseApproved"])
            self.assertEqual(len(result["evidenceRefs"]["uatOrderCycleComplete"]["sha256"]), 64)

    def test_rejects_production_evidence_that_contains_positions(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            uat = self.write_json(folder, "uat.json", {
                "environment": "uat", "complete": True, "duplicateProtected": True,
                "cancellationVerified": True, "matchedQuantity": 0,
                "readbackClassification": "TERMINAL_CANCELLED_NO_FILL",
                "realMoney": "REAL-NO-GO",
            })
            prod = self.write_json(folder, "prod.json", {
                "testedAt": "2026-08-26T07:46:39+00:00", "environment": "prod",
                "readOnly": True, "productionEnabled": False, "gatewayHost": "loopback",
                "cashVerified": True, "cashField": "cashBalance", "ordersCount": 0,
                "unresolvedCount": 0, "portfolio": [],
            })
            with self.assertRaisesRegex(ValueError, "NOT_SANITIZED"):
                reconcile({}, uat, prod)


if __name__ == "__main__":
    unittest.main()
