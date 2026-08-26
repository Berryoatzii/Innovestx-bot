import hashlib
import hmac
import unittest
from unittest.mock import patch

from private_worker import (
    EXECUTION_CONFIRMATION,
    WorkerError,
    _canonical,
    classify_broker_order,
    preflight,
    validate_worker_environment,
    verify_claim,
)


class PrivateWorkerTests(unittest.TestCase):
    def base_values(self):
        return {
            "BROKER_ENVIRONMENT": "prod",
            "BROKER_PRODUCTION_ENABLED": "false",
            "BROKER_PRODUCTION_READ_ONLY": "true",
            "ORDER_INTENT_GATE_SECRET": "intent-secret",
            "BROKER_BOARD_LOT": "100",
            "BROKER_MAX_ORDER_VALUE": "1000",
            "MIN_LIVE_CASH_RESERVE": "5000",
        }

    def payload(self):
        return {
            "intentId": "0123456789abcdef",
            "claimId": "a" * 32,
            "symbol": "TTB",
            "side": "BUY",
            "quantity": 100,
            "price": 2.90,
            "orderStyle": "RESTING_LIMIT",
            "expiresAt": "2026-08-26T10:00:00Z",
        }

    def test_dry_run_requires_production_read_only(self):
        validate_worker_environment(self.base_values(), execute=False, confirmation="")
        unsafe = {**self.base_values(), "BROKER_PRODUCTION_ENABLED": "true"}
        with self.assertRaisesRegex(WorkerError, "DRY_RUN_REQUIRES_PRODUCTION_READ_ONLY"):
            validate_worker_environment(unsafe, execute=False, confirmation="")

    def test_execute_requires_all_independent_gates(self):
        live = {
            **self.base_values(),
            "BROKER_PRODUCTION_ENABLED": "true",
            "BROKER_PRODUCTION_READ_ONLY": "false",
            "BROKER_PRODUCTION_CONFIRMATION": "broker-confirmation",
            "PRIVATE_WORKER_EXECUTION_ENABLED": "true",
        }
        validate_worker_environment(live, execute=True, confirmation=EXECUTION_CONFIRMATION)
        with self.assertRaisesRegex(WorkerError, "EXPLICIT_PRIVATE_WORKER"):
            validate_worker_environment(live, execute=True, confirmation="wrong")

    def test_claim_signature_is_verified(self):
        payload = self.payload()
        signature = hmac.new(b"intent-secret", _canonical(payload).encode(), hashlib.sha256).hexdigest()
        self.assertEqual(verify_claim(self.base_values(), {"payload": payload, "signature": signature}), payload)
        with self.assertRaisesRegex(WorkerError, "SIGNED_CLAIM_MISMATCH"):
            verify_claim(self.base_values(), {"payload": {**payload, "price": 3.0}, "signature": signature})

    def test_broker_status_classification_handles_settrade_cancel_code(self):
        self.assertEqual(classify_broker_order({"status": "CX", "matchedQuantity": 0}), "CANCELLED")
        self.assertEqual(classify_broker_order({"status": "S", "canCancel": True}), "ACKNOWLEDGED")
        self.assertEqual(classify_broker_order({
            "status": "MP", "quantity": 100, "matchedQuantity": 25,
        }), "PARTIALLY_FILLED")
        self.assertEqual(classify_broker_order({
            "status": "M", "quantity": 100, "matchedQuantity": 100,
        }), "FILLED")

    @patch("private_worker._gateway")
    def test_preflight_rejects_open_orders_and_does_not_post(self, gateway):
        gateway.side_effect = [
            {"ready": True, "unresolvedOperations": 0},
            {"operations": []},
            {"cashVerified": True, "cash": 10000, "orders": [{"status": "S"}]},
        ]
        with self.assertRaisesRegex(WorkerError, "OPEN_ORDER_EXISTS"):
            preflight(self.base_values(), self.payload())
        self.assertTrue(all(call.args[1] == "GET" for call in gateway.call_args_list))

    @patch("private_worker._gateway")
    def test_preflight_returns_exact_approved_limit(self, gateway):
        gateway.side_effect = [
            {"ready": True, "unresolvedOperations": 0},
            {"operations": []},
            {"cashVerified": True, "cash": 10000, "orders": []},
            {"quote": {"marketStatus": "Open2", "last": 2.94, "bid": 2.92, "ask": 2.94}},
        ]
        self.assertEqual(preflight(self.base_values(), self.payload()), {
            "symbol": "TTB", "side": "BUY", "quantity": 100, "price": 2.90,
        })


if __name__ == "__main__":
    unittest.main()
