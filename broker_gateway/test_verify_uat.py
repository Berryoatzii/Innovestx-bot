import io
import unittest
from urllib.error import HTTPError

from verify_uat import (
    VerificationError,
    cash_field_candidates,
    summarize_recovery,
    summarize_recovery_candidates,
    summarize_uat,
    request_json,
)


class VerifyUatTests(unittest.TestCase):
    def test_http_error_reports_only_safe_local_gateway_code(self):
        def opener(*_args, **_kwargs):
            raise HTTPError(
                "http://127.0.0.1:8787/v1/account-snapshot",
                502,
                "Bad Gateway",
                {},
                io.BytesIO(b'{"error":"BROKER_GATEWAY_FAILURE","secret":"must-not-leak"}'),
            )

        with self.assertRaisesRegex(VerificationError, "UAT_HTTP_502:BROKER_GATEWAY_FAILURE") as caught:
            request_json("http://127.0.0.1:8787", "private-token", "/v1/account-snapshot", opener=opener)
        self.assertNotIn("private-token", str(caught.exception))
        self.assertNotIn("must-not-leak", str(caught.exception))

    def test_unresolved_recovery_summary_exposes_status_only(self):
        result = summarize_recovery({
            "ok": True,
            "environment": "uat",
            "data": {
                "environment": "uat",
                "operations": [{
                    "requestId": "intent-001",
                    "operation": "PLACE",
                    "status": "EXECUTION_UNCERTAIN",
                    "orderNo": None,
                    "createdAt": "2026-08-05T00:00:00Z",
                    "updatedAt": "2026-08-05T00:01:00Z",
                    "fingerprint": "must-not-leak",
                }],
            },
        })
        self.assertEqual(result["count"], 1)
        self.assertTrue(result["requiresReconciliation"])
        self.assertNotIn("fingerprint", str(result).lower())
        self.assertNotIn("must-not-leak", str(result))

    def test_recovery_candidate_summary_never_claims_automatic_resolution(self):
        result = summarize_recovery_candidates({
            "ok": True,
            "environment": "uat",
            "data": {
                "environment": "uat",
                "operations": [
                    {"requestId": "one", "classification": "EXACTLY_ONE_CANDIDATE", "matchCount": 1},
                    {"requestId": "many", "classification": "AMBIGUOUS", "matchCount": 2},
                ],
            },
        })
        self.assertEqual(result["exactlyOne"], 1)
        self.assertEqual(result["ambiguous"], 1)
        self.assertTrue(result["requiresManualReconciliation"])
        self.assertFalse(result["automaticallyResolved"])

    def test_cash_candidates_use_schema_names_only_and_never_values(self):
        candidates = cash_field_candidates({
            "ok": True,
            "environment": "uat",
            "data": {
                "environment": "uat",
                "fields": [
                    {"path": "cashBalance", "type": "number"},
                    {"path": "buyingPower", "type": "number"},
                    {"path": "accountType", "type": "string"},
                    {"path": "marketValue", "type": "number"},
                ],
            },
        })
        self.assertEqual(candidates, ["buyingPower", "cashBalance"])
        self.assertNotIn("12500", str(candidates))

    def test_summarizes_read_only_uat_without_exposing_account_details(self):
        result = summarize_uat(
            {"ok": True, "environment": "uat", "data": {"ready": True, "environment": "uat"}},
            {
                "ok": True,
                "environment": "uat",
                "data": {
                    "environment": "uat",
                    "cash": 12500.5,
                    "cashVerified": True,
                    "accountInfo": {"accountType": "Cash", "accountNo": "SECRET-ACCOUNT"},
                    "portfolio": [{"sym": "AOT", "qty": 100}],
                    "orders": [
                        {"orderNo": "9001", "status": "O", "quantity": 100, "matchedQuantity": 0},
                        {"orderNo": "9000", "status": "CX", "quantity": 100, "matchedQuantity": 0},
                    ],
                },
            },
        )
        self.assertEqual(result, {
            "environment": "uat",
            "gatewayReady": True,
            "accountType": "Cash",
            "cashVerified": True,
            "cash": 12500.5,
            "positions": 1,
            "orders": 1,
            "ordersTotal": 2,
        })
        self.assertNotIn("accountNo", result)

    def test_rejects_any_non_uat_response(self):
        with self.assertRaisesRegex(VerificationError, "UAT_ENVIRONMENT_MISMATCH"):
            summarize_uat(
                {"ok": True, "environment": "prod", "data": {"ready": True}},
                {"ok": True, "environment": "prod", "data": {}},
            )

    def test_rejects_unready_or_unverified_payloads(self):
        with self.assertRaisesRegex(VerificationError, "UAT_GATEWAY_NOT_READY"):
            summarize_uat(
                {"ok": True, "environment": "uat", "data": {"ready": False}},
                {"ok": True, "environment": "uat", "data": {}},
            )

        with self.assertRaisesRegex(VerificationError, "UAT_SNAPSHOT_INVALID"):
            summarize_uat(
                {"ok": True, "environment": "uat", "data": {"ready": True}},
                {"ok": False, "environment": "uat", "data": {}},
            )


if __name__ == "__main__":
    unittest.main()
