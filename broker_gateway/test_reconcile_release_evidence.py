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

    def test_promotes_account_activation_without_approving_strategy(self):
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
            broker = self.write_json(folder, "broker.json", {
                "evidenceType": "BROKER_OPEN_API_ACCOUNT_ACTIVATION",
                "broker": "InnovestX Securities",
                "sourceSender": "no-reply@innovestx.co.th",
                "sourceSubject": "Your account has been activated for Settrade Open API",
                "sourceReceivedAt": "2026-06-05T19:01:00+07:00",
                "verifiedAt": "2026-08-29T16:17:00+07:00",
                "accountLevelOpenApiActivated": True,
                "apiKeyProvisioningOffered": True,
                "strategyLogicParametersApproved": False,
                "accountIdentifiersRedacted": True,
                "secretMaterialPresent": False,
            })
            with patch("reconcile_release_evidence.datetime") as clock:
                clock.now.return_value = __import__("datetime").datetime(2026, 8, 26, 8, 0, tzinfo=__import__("datetime").timezone.utc)
                clock.fromisoformat.side_effect = __import__("datetime").datetime.fromisoformat
                result = reconcile(
                    {"brokerPermissionConfirmed": False, "strategyReleaseApproved": False},
                    uat,
                    prod,
                    folder,
                    broker,
                )

            self.assertTrue(result["brokerPermissionConfirmed"])
            self.assertFalse(result["strategyReleaseApproved"])
            self.assertEqual(
                result["evidenceRefs"]["brokerPermissionConfirmed"]["path"],
                "broker.json",
            )

    def test_rejects_broker_activation_that_claims_strategy_approval(self):
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
            broker = self.write_json(folder, "broker.json", {
                "evidenceType": "BROKER_OPEN_API_ACCOUNT_ACTIVATION",
                "broker": "InnovestX Securities",
                "sourceSender": "no-reply@innovestx.co.th",
                "sourceSubject": "Your account has been activated for Settrade Open API",
                "sourceReceivedAt": "2026-06-05T19:01:00+07:00",
                "verifiedAt": "2026-08-29T16:17:00+07:00",
                "accountLevelOpenApiActivated": True,
                "apiKeyProvisioningOffered": True,
                "strategyLogicParametersApproved": True,
                "accountIdentifiersRedacted": True,
                "secretMaterialPresent": False,
            })
            with patch("reconcile_release_evidence.datetime") as clock:
                clock.now.return_value = __import__("datetime").datetime(2026, 8, 26, 8, 0, tzinfo=__import__("datetime").timezone.utc)
                clock.fromisoformat.side_effect = __import__("datetime").datetime.fromisoformat
                with self.assertRaisesRegex(ValueError, "strategyLogicParametersApproved"):
                    reconcile({}, uat, prod, folder, broker)

    def test_promotes_hash_bound_execution_compatibility_without_unlocking_strategy(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / "config").mkdir()
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
            candidate = self.write_json(folder / "config", "strategy-approval-candidate.json", {
                "candidateId": "CANDIDATE-1",
                "strategyVersion": "V1",
            })
            import hashlib
            candidate_hash = hashlib.sha256(candidate.read_bytes()).hexdigest()
            execution = self.write_json(folder / "config", "execution.json", {
                "evidenceType": "DR_EXECUTION_COMPATIBILITY",
                "passed": True,
                "candidateId": "CANDIDATE-1",
                "strategyVersion": "V1",
                "candidateSha256": candidate_hash,
                "restingLimitOnlyVerified": True,
                "perOrderBoardLotVerified": True,
                "freshFullExitQuantityVerified": True,
                "privateWorkerPayloadBound": True,
                "candidateDrScopeVerified": True,
                "productionLockedDuringVerification": True,
                "brokerCalled": False,
                "moneyMoving": False,
            })
            with patch("reconcile_release_evidence.datetime") as clock:
                clock.now.return_value = __import__("datetime").datetime(2026, 8, 26, 8, 0, tzinfo=__import__("datetime").timezone.utc)
                clock.fromisoformat.side_effect = __import__("datetime").datetime.fromisoformat
                result = reconcile(
                    {"strategyReleaseApproved": False, "forwardShadowVerified": False},
                    uat,
                    prod,
                    folder,
                    None,
                    execution,
                )

            self.assertTrue(result["executionCompatibilityVerified"])
            self.assertFalse(result["strategyReleaseApproved"])
            self.assertFalse(result["forwardShadowVerified"])
            self.assertEqual(
                result["evidenceRefs"]["executionCompatibilityVerified"]["path"],
                "config/execution.json",
            )


if __name__ == "__main__":
    unittest.main()
