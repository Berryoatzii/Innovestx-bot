import os
import json
import http.client
import tempfile
import threading
import unittest
from http.server import HTTPServer

from gateway import (
    BrokerGatewayConfig,
    BrokerHTTPServer,
    BrokerJournal,
    BrokerPolicyError,
    BrokerService,
    ExecutionUncertainError,
    ProcessFence,
    SdkEquityProxy,
    GatewayHandler,
    configure_sdk_environment,
    load_env_file,
)


def uat_env(**overrides):
    values = {
        "BROKER_ENVIRONMENT": "uat",
        "SETTRADE_APP_ID": "test-app",
        "SETTRADE_APP_SECRET": "test-secret",
        "SETTRADE_APP_CODE": "ALGO_EQ",
        "SETTRADE_ACCOUNT_NO": "TEST-ACCOUNT",
        "SETTRADE_PIN": "000000",
        "BROKER_GATEWAY_TOKEN": "gateway-token",
        "BROKER_MAX_ORDER_VALUE": "3000",
        "BROKER_CASH_FIELD": "cashBalance",
        "BROKER_REQUIRED_ACCOUNT_TYPE": "Cash",
        "BROKER_BOARD_LOT": "100",
        "BROKER_CASH_BUFFER_BPS": "100",
    }
    values.update(overrides)
    return values


class FakeEquity:
    def __init__(self):
        self.place_calls = []
        self.cancel_calls = []
        self.order = {
            "accountNo": "SECRET-ACCOUNT",
            "orderNo": "9001",
            "symbol": "AOT",
            "side": "Buy",
            "vol": 100,
            "matched": 0,
            "price": 20,
            "status": "SX",
            "canCancel": True,
        }
        self.orders = [dict(self.order)]
        self.place_response = dict(self.order)

    def get_account_info(self):
        return {"cashBalance": 12500.5, "accountType": "Cash", "accountNo": "SECRET-ACCOUNT"}

    def get_portfolios(self):
        return [{"symbol": "AOT", "actualVolume": 100, "averagePrice": 18, "marketPrice": 20}]

    def get_orders(self):
        return [dict(item) for item in self.orders]

    def get_quote_symbol(self, symbol):
        return {
            "symbol": str(symbol).upper(), "last": 20.1, "bid": 20.0, "ask": 20.2,
            "marketStatus": "Open", "status": "Normal",
            "high": 20.5, "low": 19.8, "prior": 19.9, "change": 0.2,
            "ceiling": 25.75, "floor": 13.95,
            "percentChange": 1.005, "totalVolume": 250000,
            "accountNo": "MUST-NOT-LEAK",
        }

    def get_bid_offer_symbol(self, symbol):
        return {
            "symbol": str(symbol).upper(),
            "bid_price1": 20.0,
            "ask_price1": 20.2,
            "bid_volume1": 1000,
            "ask_volume1": 800,
            "bid_flag": "NORMAL",
            "ask_flag": "NORMAL",
            "accountNo": "MUST-NOT-LEAK",
        }

    def get_order(self, order_no):
        return dict(self.order, orderNo=str(order_no))

    def place_order(self, **kwargs):
        self.place_calls.append(kwargs)
        if isinstance(self.place_response, Exception):
            raise self.place_response
        return dict(self.place_response)

    def cancel_order(self, order_no, pin):
        self.cancel_calls.append((str(order_no), pin))
        self.order.update({"canCancel": False, "status": "Cancelled", "cancelled": 100})
        return dict(self.order)


class SettradeError(Exception):
    def __init__(self, code, status_code, message="private broker message"):
        self.code = code
        self.status_code = status_code
        super().__init__(message)


class ConfigTests(unittest.TestCase):
    def test_gateway_listener_never_reuses_an_active_port(self):
        self.assertFalse(BrokerHTTPServer.allow_reuse_address)

    def test_board_lot_overrides_are_exact_symbol_only_and_fail_closed(self):
        config = BrokerGatewayConfig.from_mapping(
            uat_env(BROKER_BOARD_LOT_OVERRIDES_JSON='{"NVDA80":1,"SPECIAL":50}')
        )
        self.assertEqual(config.board_lot_for("NVDA80"), 1)
        self.assertEqual(config.board_lot_for("nvda80"), 1)
        self.assertEqual(config.board_lot_for("AOT"), 100)
        self.assertEqual(config.board_lot_for("NVDA80X"), 100)

        for invalid in (
            "not-json",
            "[]",
            '{"NVDA*":1}',
            '{"NVDA80":0}',
            '{"NVDA80":true}',
            '{"NVDA80":1.5}',
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(BrokerPolicyError, "BROKER_BOARD_LOT_OVERRIDES_INVALID"):
                    BrokerGatewayConfig.from_mapping(
                        uat_env(BROKER_BOARD_LOT_OVERRIDES_JSON=invalid)
                    )
    def test_sdk_environment_is_explicitly_bound_to_gateway_environment(self):
        sdk_config = {"environment": "prod"}
        configure_sdk_environment(sdk_config, "uat")
        self.assertEqual(sdk_config["environment"], "uat")

        with self.assertRaisesRegex(BrokerPolicyError, "SDK_ENVIRONMENT_INVALID"):
            configure_sdk_environment(sdk_config, "staging")

    def test_uat_forces_official_sandbox_broker(self):
        config = BrokerGatewayConfig.from_mapping(uat_env(SETTRADE_BROKER_ID="023"))
        self.assertEqual(config.environment, "uat")
        self.assertEqual(config.sdk_broker_id, "SANDBOX")
        self.assertFalse(config.production_enabled)

    def test_production_read_only_allows_reads_without_order_unlocks(self):
        values = uat_env(
            BROKER_ENVIRONMENT="prod",
            SETTRADE_BROKER_ID="023",
            BROKER_PRODUCTION_READ_ONLY="true",
            BROKER_PRODUCTION_ENABLED="false",
            BROKER_PRODUCTION_ACK="",
            BROKER_PRODUCTION_CONFIRMATION="",
            BROKER_CASH_FIELD="",
            BROKER_REQUIRED_ACCOUNT_TYPE="",
        )
        config = BrokerGatewayConfig.from_mapping(values)
        self.assertTrue(config.production_read_only)
        self.assertFalse(config.production_enabled)
        self.assertEqual(config.sdk_broker_id, "023")

    def test_production_read_only_rejects_any_order_unlock(self):
        values = uat_env(
            BROKER_ENVIRONMENT="prod",
            SETTRADE_BROKER_ID="023",
            BROKER_PRODUCTION_READ_ONLY="true",
            BROKER_PRODUCTION_ACK="I_ACCEPT_REAL_ORDER_RESPONSIBILITY",
        )
        with self.assertRaisesRegex(BrokerPolicyError, "PRODUCTION_READ_ONLY_MUST_NOT_HAVE_ORDER_UNLOCKS"):
            BrokerGatewayConfig.from_mapping(values)

    def test_production_requires_three_explicit_unlocks(self):
        values = uat_env(BROKER_ENVIRONMENT="prod", SETTRADE_BROKER_ID="023")
        with self.assertRaisesRegex(BrokerPolicyError, "PRODUCTION_DISABLED"):
            BrokerGatewayConfig.from_mapping(values)

        values.update({
            "BROKER_PRODUCTION_ENABLED": "true",
            "BROKER_PRODUCTION_ACK": "I_ACCEPT_REAL_ORDER_RESPONSIBILITY",
        })
        with self.assertRaisesRegex(BrokerPolicyError, "PRODUCTION_CONFIRMATION_REQUIRED"):
            BrokerGatewayConfig.from_mapping(values)

        values["BROKER_PRODUCTION_CONFIRMATION"] = "one-time-production-confirmation"
        config = BrokerGatewayConfig.from_mapping(values)
        self.assertTrue(config.production_enabled)
        self.assertEqual(config.sdk_broker_id, "023")

    def test_production_requires_explicit_cash_account_controls(self):
        values = uat_env(
            BROKER_ENVIRONMENT="prod",
            SETTRADE_BROKER_ID="023",
            BROKER_PRODUCTION_ENABLED="true",
            BROKER_PRODUCTION_ACK="I_ACCEPT_REAL_ORDER_RESPONSIBILITY",
            BROKER_PRODUCTION_CONFIRMATION="one-time-production-confirmation",
            BROKER_CASH_FIELD="",
        )
        with self.assertRaisesRegex(BrokerPolicyError, "PRODUCTION_CASH_CONTROLS_REQUIRED"):
            BrokerGatewayConfig.from_mapping(values)

    def test_missing_environment_fails_closed(self):
        with self.assertRaisesRegex(BrokerPolicyError, "BROKER_ENVIRONMENT"):
            BrokerGatewayConfig.from_mapping({})

    def test_env_file_loader_does_not_override_process_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, ".env")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("BROKER_ENVIRONMENT=uat\nSETTRADE_PIN='123456'\n# ignored\n")
            target = {"SETTRADE_PIN": "existing"}
            load_env_file(path, target)
            self.assertEqual(target["BROKER_ENVIRONMENT"], "uat")
            self.assertEqual(target["SETTRADE_PIN"], "existing")

    def test_process_fence_allows_only_one_gateway_for_the_same_account(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "gateway.lock")
            first = ProcessFence(path)
            try:
                with self.assertRaisesRegex(BrokerPolicyError, "GATEWAY_ALREADY_RUNNING_FOR_ACCOUNT"):
                    ProcessFence(path)
            finally:
                first.close()
            second = ProcessFence(path)
            second.close()


class BrokerServiceTests(unittest.TestCase):
    def setUp(self):
        self.config = BrokerGatewayConfig.from_mapping(uat_env())
        self.equity = FakeEquity()
        self.equity.orders = []
        self.tempdir = tempfile.TemporaryDirectory()
        self.journal = BrokerJournal(os.path.join(self.tempdir.name, "journal.sqlite3"))
        self.service = BrokerService(self.config, self.equity, self.journal)

    def tearDown(self):
        self.journal.close()
        self.tempdir.cleanup()

    def test_snapshot_uses_account_info_for_verified_cash(self):
        self.equity.orders = [dict(self.equity.order)]
        snapshot = self.service.account_snapshot()
        self.assertEqual(snapshot["cash"], 12500.5)
        self.assertTrue(snapshot["cashVerified"])
        self.assertEqual(snapshot["portfolio"][0]["sym"], "AOT")
        self.assertEqual(snapshot["accountInfo"], {"accountType": "Cash"})
        self.assertNotIn("accountNo", snapshot["orders"][0])

    def test_snapshot_accepts_official_sdk_portfolio_wrapper(self):
        self.equity.get_portfolios = lambda: {
            "portfolioList": [
                {"symbol": "PTT", "actualVolume": 100, "averagePrice": 30, "marketPrice": 31}
            ],
            "totalPortfolio": {"marketValue": 3100},
        }
        snapshot = self.service.account_snapshot()
        self.assertEqual(snapshot["portfolio"], [{"sym": "PTT", "qty": 100.0, "avg": 30.0, "mkt": 31.0}])

    def test_snapshot_rejects_unknown_portfolio_shape(self):
        self.equity.get_portfolios = lambda: {"unexpected": []}
        with self.assertRaisesRegex(BrokerPolicyError, "PORTFOLIO_RESPONSE_UNVERIFIED"):
            self.service.account_snapshot()

    def test_quote_is_normalized_and_contains_no_account_data(self):
        quote = self.service.quote("AOT")
        self.assertEqual(quote["symbol"], "AOT")
        self.assertEqual(quote["last"], 20.1)
        self.assertEqual(quote["volume"], 250000)
        self.assertEqual(quote["marketStatus"], "Open")
        self.assertEqual(quote["ceiling"], 25.75)
        self.assertEqual(quote["floor"], 13.95)
        self.assertNotIn("accountNo", quote)

    def test_market_snapshot_merges_realtime_bid_offer_without_account_data(self):
        snapshot = self.service.market_snapshot("AOT")
        self.assertEqual(snapshot["symbol"], "AOT")
        self.assertEqual(snapshot["bid"], 20.0)
        self.assertEqual(snapshot["ask"], 20.2)
        self.assertEqual(snapshot["bidVolume"], 1000)
        self.assertEqual(snapshot["askVolume"], 800)
        self.assertEqual(snapshot["bidFlag"], "NORMAL")
        self.assertNotIn("accountNo", snapshot)

    def test_uat_account_schema_lists_types_but_never_sensitive_fields_or_values(self):
        schema = self.service.account_schema()
        self.assertIn({"path": "cashBalance", "type": "number"}, schema["fields"])
        self.assertIn({"path": "accountType", "type": "string"}, schema["fields"])
        self.assertFalse(any(item["path"] == "accountNo" for item in schema["fields"]))
        self.assertNotIn("12500.5", str(schema))

    def test_missing_configured_cash_field_fails_closed(self):
        config = BrokerGatewayConfig.from_mapping(uat_env(BROKER_CASH_FIELD="unknownField"))
        service = BrokerService(config, self.equity, self.journal)
        snapshot = service.account_snapshot()
        self.assertIsNone(snapshot["cash"])
        self.assertFalse(snapshot["cashVerified"])

    def test_same_request_id_never_places_twice(self):
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        first = self.service.place_order("intent-001", payload)
        self.equity.orders = [dict(self.equity.order, status="SX")]
        second = self.service.place_order("intent-001", payload)
        self.assertEqual(first["orderNo"], "9001")
        self.assertEqual(second["orderNo"], "9001")
        self.assertTrue(second["duplicate"])
        self.assertEqual(len(self.equity.place_calls), 1)
        self.assertTrue(self.equity.place_calls[0]["bypass_warning"])
        self.assertEqual(self.equity.place_calls[0]["valid_till_date"], "")

    def test_order_board_lot_is_resolved_per_exact_symbol(self):
        config = BrokerGatewayConfig.from_mapping(
            uat_env(BROKER_BOARD_LOT_OVERRIDES_JSON='{"NVDA80":1}')
        )
        service = BrokerService(config, self.equity, self.journal)

        self.assertEqual(
            service._validate_order(
                {"symbol": "NVDA80", "side": "BUY", "quantity": 1, "price": 20}
            )["quantity"],
            1,
        )
        with self.assertRaisesRegex(BrokerPolicyError, "BOARD_LOT_REQUIRED"):
            service._validate_order(
                {"symbol": "AOT", "side": "BUY", "quantity": 1, "price": 20}
            )

    def test_broker_success_without_order_number_is_uncertain_and_never_retried(self):
        self.equity.place_response = {"status": "success"}
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        with self.assertRaises(ExecutionUncertainError):
            self.service.place_order("intent-002", payload)
        with self.assertRaises(ExecutionUncertainError):
            self.service.place_order("intent-002", payload)
        self.assertEqual(len(self.equity.place_calls), 1)

    def test_transport_failure_is_uncertain_and_never_retried(self):
        self.equity.place_response = TimeoutError("network timeout")
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        with self.assertRaises(ExecutionUncertainError):
            self.service.place_order("intent-003", payload)
        with self.assertRaises(ExecutionUncertainError):
            self.service.place_order("intent-003", payload)
        self.assertEqual(len(self.equity.place_calls), 1)

    def test_definite_settrade_rejection_does_not_freeze_future_mutations(self):
        self.equity.place_response = SettradeError("PRICE_WARNING", 422)
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        with self.assertRaisesRegex(
            BrokerPolicyError,
            "BROKER_PLACE_REJECTED:SettradeError:422:PRICE_WARNING",
        ):
            self.service.place_order("intent-rejected-001", payload)
        self.assertEqual(self.journal.list_unresolved(), [])
        row = self.journal.find("intent-rejected-001")
        self.assertEqual(row["status"], "REJECTED")
        self.assertEqual(row["error"], "SettradeError:422:PRICE_WARNING")
        self.assertNotIn("private broker message", str(row))

    def test_retryable_settrade_error_remains_execution_uncertain(self):
        self.equity.place_response = SettradeError("RATE_LIMIT", 429)
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        with self.assertRaises(ExecutionUncertainError):
            self.service.place_order("intent-retryable-001", payload)
        self.assertEqual(self.journal.list_unresolved()[0]["status"], "EXECUTION_UNCERTAIN")
        self.assertEqual(
            self.journal.find("intent-retryable-001")["error"],
            "SettradeError:429:RATE_LIMIT",
        )

    def test_broker_accept_before_journal_failure_freezes_and_recovers_read_only(self):
        def accepted_order(**kwargs):
            self.equity.place_calls.append(kwargs)
            accepted = dict(self.equity.order, orderNo="9911", status="SX")
            self.equity.orders = [accepted]
            return accepted

        self.equity.place_order = accepted_order
        original_update = self.journal.update

        def broken_update(request_id, status, **kwargs):
            if status in {"SUBMITTED", "EXECUTION_UNCERTAIN"}:
                raise OSError("simulated disk failure with private detail")
            return original_update(request_id, status, **kwargs)

        self.journal.update = broken_update
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        with self.assertRaisesRegex(ExecutionUncertainError, "JOURNAL_UPDATE_FAILED"):
            self.service.place_order("intent-journal-failure-001", payload)

        unresolved = self.journal.list_unresolved()
        self.assertEqual(unresolved[0]["status"], "SUBMITTING")
        self.assertEqual(len(self.equity.place_calls), 1)
        candidates = self.service.recovery_candidates()
        self.assertEqual(candidates[0]["classification"], "EXACTLY_ONE_CANDIDATE")
        self.assertEqual(candidates[0]["candidates"][0]["orderNo"], "9911")
        with self.assertRaisesRegex(BrokerPolicyError, "MUTATIONS_FROZEN_UNRESOLVED"):
            self.service.place_order("intent-journal-failure-002", {
                "symbol": "PTT", "side": "BUY", "quantity": 100, "price": 20,
            })
        self.assertEqual(len(self.equity.place_calls), 1)

    def test_uncertain_request_is_not_replayed_after_process_restart(self):
        self.equity.place_response = TimeoutError("network timeout")
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        with self.assertRaises(ExecutionUncertainError):
            self.service.place_order("intent-restart-001", payload)

        journal_path = self.journal._db.execute("PRAGMA database_list").fetchone()[2]
        self.journal.close()
        self.journal = BrokerJournal(journal_path)
        restarted = BrokerService(self.config, self.equity, self.journal)
        with self.assertRaisesRegex(ExecutionUncertainError, "ORDER_ALREADY_ATTEMPTED"):
            restarted.place_order("intent-restart-001", payload)
        self.assertEqual(len(self.equity.place_calls), 1)

    def test_cancelled_cx_history_does_not_block_a_new_same_side_order(self):
        self.equity.orders = [{
            "orderNo": "old-cancelled", "symbol": "AOT", "side": "Buy",
            "price": 20, "vol": 100, "matched": 0, "status": "CX",
        }]
        self.equity.place_response = dict(self.equity.order, orderNo="new-order")

        result = self.service.place_order("intent-after-cx-001", {
            "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
        })

        self.assertEqual(result["orderNo"], "new-order")
        self.assertEqual(len(self.equity.place_calls), 1)

    def test_unresolved_operation_freezes_every_new_mutation(self):
        self.equity.place_response = TimeoutError("network timeout with secret detail")
        payload = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        with self.assertRaises(ExecutionUncertainError):
            self.service.place_order("intent-freeze-001", payload)

        self.equity.place_response = dict(self.equity.order, orderNo="9002")
        with self.assertRaisesRegex(BrokerPolicyError, "MUTATIONS_FROZEN_UNRESOLVED"):
            self.service.place_order("intent-freeze-002", {
                "symbol": "PTT", "side": "BUY", "quantity": 100, "price": 20,
            })
        with self.assertRaisesRegex(BrokerPolicyError, "MUTATIONS_FROZEN_UNRESOLVED"):
            self.service.cancel_order("cancel-freeze-001", "9001")
        self.assertEqual(len(self.equity.place_calls), 1)
        self.assertEqual(len(self.equity.cancel_calls), 0)

        error = self.journal._db.execute(
            "SELECT error FROM operations WHERE request_id = ?", ("intent-freeze-001",)
        ).fetchone()[0]
        self.assertEqual(error, "TimeoutError")

    def test_unresolved_journal_is_sanitized_and_survives_restart(self):
        fingerprint = "secret-fingerprint-that-must-not-leak"
        self.journal.reserve(
            "intent-unresolved-001", "PLACE", fingerprint,
            request={
                "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
                "pin": "must-not-be-stored",
            },
        )
        rows = self.journal.list_unresolved()
        self.assertEqual(rows[0]["requestId"], "intent-unresolved-001")
        self.assertEqual(rows[0]["status"], "SUBMITTING")
        self.assertEqual(rows[0]["order"], {
            "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20.0,
        })
        self.assertNotIn("fingerprint", rows[0])
        self.assertNotIn("response", rows[0])
        self.assertNotIn("pin", str(rows).lower())
        self.assertNotIn("must-not-be-stored", str(rows))
        self.assertNotIn(fingerprint, str(rows))

        self.journal.update("intent-unresolved-001", "SUBMITTED", order_no="9001")
        self.assertEqual(self.journal.list_unresolved(), [])

    def test_recovery_candidates_match_exact_order_without_mutation(self):
        self.equity.orders = [dict(self.equity.order)]
        self.journal.reserve(
            "intent-recovery-001", "PLACE", "fingerprint",
            request={"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
        )
        result = self.service.recovery_candidates()
        self.assertEqual(result[0]["requestId"], "intent-recovery-001")
        self.assertEqual(result[0]["matchCount"], 1)
        self.assertEqual(result[0]["classification"], "EXACTLY_ONE_CANDIDATE")
        self.assertEqual(result[0]["candidates"][0]["orderNo"], "9001")
        self.assertEqual(len(self.equity.place_calls), 0)
        self.assertEqual(len(self.equity.cancel_calls), 0)

    def test_recovery_candidates_never_guess_when_multiple_orders_match(self):
        self.journal.reserve(
            "intent-recovery-002", "PLACE", "fingerprint",
            request={"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
        )
        original = dict(self.equity.order)
        self.equity.orders = [
            dict(original, orderNo="9001"),
            dict(original, orderNo="9002"),
        ]
        result = self.service.recovery_candidates()
        self.assertEqual(result[0]["matchCount"], 2)
        self.assertEqual(result[0]["classification"], "AMBIGUOUS")

    def test_reconcile_no_candidate_requires_three_clean_samples(self):
        self.journal.reserve(
            "intent-reconcile-001", "PLACE", "fingerprint",
            request={"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
        )
        self.journal.update(
            "intent-reconcile-001", "EXECUTION_UNCERTAIN",
            error="SettradeError:422:PRICE_WARNING",
        )
        clean = {"classification": "NO_CANDIDATE", "positions": 0, "orders": 0}
        with self.assertRaisesRegex(BrokerPolicyError, "NO_CANDIDATE_PROOF_REQUIRED"):
            self.journal.resolve_no_candidate(
                "intent-reconcile-001", proof={"samples": [clean, clean]}
            )
        self.assertTrue(self.journal.has_unresolved())

        self.journal.resolve_no_candidate(
            "intent-reconcile-001",
            proof={"samples": [clean, clean, clean], "checkedAt": "2026-08-06T07:00:00Z"},
        )
        self.assertFalse(self.journal.has_unresolved())
        row = self.journal.find("intent-reconcile-001")
        self.assertEqual(row["status"], "RECONCILED_NO_CANDIDATE")
        self.assertEqual(row["error"], "SettradeError:422:PRICE_WARNING")
        self.assertNotIn("fingerprint", str(row.get("response_json")))

    def test_reconcile_terminal_cancel_requires_three_complete_samples(self):
        self.journal.reserve(
            "cancel-reconcile-001", "CANCEL", "fingerprint",
            request={"orderNo": "9001"},
        )
        self.journal.update(
            "cancel-reconcile-001", "EXECUTION_UNCERTAIN",
            order_no="9001", error="CANCEL_NOT_CONFIRMED_BY_BROKER",
        )
        clean = {
            "status": "CX", "canCancel": False, "quantity": 100,
            "matchedQuantity": 0, "cancelled": 100,
        }
        with self.assertRaisesRegex(BrokerPolicyError, "TERMINAL_CANCEL_PROOF_REQUIRED"):
            self.journal.resolve_terminal_cancel(
                "cancel-reconcile-001", proof={"samples": [clean, clean]}
            )
        self.assertTrue(self.journal.has_unresolved())

        self.journal.resolve_terminal_cancel(
            "cancel-reconcile-001",
            proof={"samples": [clean, clean, clean], "checkedAt": "2026-08-26T08:00:00Z"},
        )
        self.assertFalse(self.journal.has_unresolved())
        row = self.journal.find("cancel-reconcile-001")
        self.assertEqual(row["status"], "RECONCILED_CANCELLED")
        self.assertEqual(row["error"], "CANCEL_NOT_CONFIRMED_BY_BROKER")

    def test_normalized_order_drops_raw_reject_reason_and_uses_display_status(self):
        normalized = self.service._normalize_order({
            "orderNo": "9001",
            "symbol": "AOT",
            "showOrderStatus": "Rejected",
            "rejectCode": 123,
            "rejectReason": "free-form broker text must not cross the gateway",
        })
        self.assertEqual(normalized["status"], "Rejected")
        self.assertEqual(normalized["rejectCode"], 123)
        self.assertNotIn("rejectReason", normalized)

        unsafe_code = self.service._normalize_order({
            "orderNo": "9002",
            "symbol": "AOT",
            "rejectCode": "free form code with spaces",
        })
        self.assertIsNone(unsafe_code["rejectCode"])

    def test_idempotency_key_cannot_be_reused_for_a_different_order(self):
        self.service.place_order("intent-reuse-001", {
            "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
        })
        with self.assertRaisesRegex(BrokerPolicyError, "IDEMPOTENCY_KEY_REUSED"):
            self.service.place_order("intent-reuse-001", {
                "symbol": "PTT", "side": "BUY", "quantity": 100, "price": 20,
            })
        self.assertEqual(len(self.equity.place_calls), 1)

    def test_order_value_and_order_type_are_restricted(self):
        with self.assertRaisesRegex(BrokerPolicyError, "ORDER_VALUE_LIMIT"):
            self.service.place_order("intent-004", {
                "symbol": "AOT", "side": "BUY", "quantity": 200, "price": 20,
            })

    def test_open_same_symbol_and_side_order_blocks_duplicate_submission(self):
        self.equity.orders = [dict(self.equity.order, symbol="AOT", side="Buy", status="SX")]
        with self.assertRaisesRegex(BrokerPolicyError, "OPEN_ORDER_ALREADY_EXISTS"):
            self.service.place_order("intent-open-duplicate", {
                "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
            })
        self.assertEqual(len(self.equity.place_calls), 0)

        self.equity.orders = [dict(self.equity.order, symbol="AOT", side="Buy", status="M", matched=100)]
        result = self.service.place_order("intent-after-filled", {
            "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
        })
        self.assertEqual(result["orderNo"], "9001")
        with self.assertRaisesRegex(BrokerPolicyError, "LIMIT_DAY_ONLY"):
            self.service.place_order("intent-005", {
                "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
                "priceType": "ATO",
            })

    def test_gateway_rejects_odd_lot_for_common_stock_pilot(self):
        with self.assertRaisesRegex(BrokerPolicyError, "BOARD_LOT_REQUIRED"):
            self.service.place_order("intent-board-lot", {
                "symbol": "AOT", "side": "BUY", "quantity": 50, "price": 20,
            })
        self.assertEqual(len(self.equity.place_calls), 0)

    def test_gateway_rechecks_cash_account_type_and_buying_cash(self):
        self.equity.get_account_info = lambda: {"cashBalance": 12500.5, "accountType": "CreditBalance"}
        with self.assertRaisesRegex(BrokerPolicyError, "ACCOUNT_TYPE_NOT_ALLOWED"):
            self.service.place_order("intent-account-type", {
                "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
            })

        self.equity.get_account_info = lambda: {"cashBalance": 1000, "accountType": "Cash"}
        with self.assertRaisesRegex(BrokerPolicyError, "INSUFFICIENT_VERIFIED_CASH"):
            self.service.place_order("intent-cash", {
                "symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20,
            })
        self.assertEqual(len(self.equity.place_calls), 0)

    def test_gateway_rejects_sell_above_verified_holding(self):
        with self.assertRaisesRegex(BrokerPolicyError, "INSUFFICIENT_VERIFIED_POSITION"):
            self.service.place_order("intent-position", {
                "symbol": "AOT", "side": "SELL", "quantity": 200, "price": 10,
            })
        self.assertEqual(len(self.equity.place_calls), 0)

    def test_cancel_requires_broker_permission_and_verifies_after_state(self):
        result = self.service.cancel_order("cancel-001", "9001")
        self.assertEqual(len(self.equity.cancel_calls), 1)
        self.assertEqual(result["order"]["status"], "Cancelled")
        self.assertFalse(result["order"]["canCancel"])

        duplicate = self.service.cancel_order("cancel-001", "9001")
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(len(self.equity.cancel_calls), 1)

        self.equity.order["canCancel"] = False
        with self.assertRaisesRegex(BrokerPolicyError, "ORDER_NOT_CANCELLABLE"):
            self.service.cancel_order("cancel-002", "9002")

    def test_cancel_pending_or_partial_cancel_is_not_terminal_confirmation(self):
        def pending_cancel(order_no, pin):
            self.equity.cancel_calls.append((str(order_no), pin))
            self.equity.order.update({
                "canCancel": False, "status": "Cancel Pending", "cancelled": 10,
            })
            return dict(self.equity.order)

        self.equity.cancel_order = pending_cancel
        with self.assertRaisesRegex(ExecutionUncertainError, "CANCEL_NOT_CONFIRMED"):
            self.service.cancel_order("cancel-pending-001", "9001")

    def test_cancel_accepts_settrade_cx_terminal_status(self):
        def cx_cancel(order_no, pin):
            self.equity.cancel_calls.append((str(order_no), pin))
            self.equity.order.update({
                "canCancel": False, "status": "CX", "cancelled": 100,
            })
            return dict(self.equity.order)

        self.equity.cancel_order = cx_cancel
        result = self.service.cancel_order("cancel-cx-001", "9001")
        self.assertTrue(result["cancellationVerified"])
        self.assertEqual(result["order"]["status"], "CX")
        self.assertFalse(result["order"]["canCancel"])


class UnauthorizedError(RuntimeError):
    status_code = 401


class SessionStub:
    def __init__(self, *, fail_read=False, fail_place=False):
        self.fail_read = fail_read
        self.fail_place = fail_place
        self.read_calls = 0
        self.place_calls = 0

    def get_orders(self):
        self.read_calls += 1
        if self.fail_read:
            raise UnauthorizedError("expired")
        return []

    def place_order(self, **_kwargs):
        self.place_calls += 1
        if self.fail_place:
            raise UnauthorizedError("expired")
        return {"orderNo": "1"}


class ProxyStub(SdkEquityProxy):
    def __init__(self, config, sessions):
        super().__init__(config)
        self.sessions = iter(sessions)
        self.connected = []

    def _connect(self):
        session = next(self.sessions)
        self.connected.append(session)
        self._equity = session
        return session


class SdkProxyTests(unittest.TestCase):
    def setUp(self):
        self.config = BrokerGatewayConfig.from_mapping(uat_env())

    def test_read_reconnects_once_after_401(self):
        first = SessionStub(fail_read=True)
        second = SessionStub()
        proxy = ProxyStub(self.config, [first, second])
        self.assertEqual(proxy.get_orders(), [])
        self.assertEqual(first.read_calls, 1)
        self.assertEqual(second.read_calls, 1)

    def test_mutation_never_retries_after_401(self):
        first = SessionStub(fail_place=True)
        second = SessionStub()
        proxy = ProxyStub(self.config, [first, second])
        with self.assertRaises(UnauthorizedError):
            proxy.place_order(pin="000000")
        self.assertEqual(first.place_calls, 1)
        self.assertEqual(second.place_calls, 0)
        self.assertEqual(len(proxy.connected), 1)

    def test_bid_offer_snapshot_uses_the_existing_investor_session(self):
        class Subscriber:
            def __init__(self, callback):
                self.callback = callback
                self.stopped = False

            def start(self):
                self.callback({
                    "is_success": True,
                    "data": {
                        "symbol": "AOT", "bid_price1": 20.0, "ask_price1": 20.2,
                        "bid_volume1": 1000, "ask_volume1": 800,
                        "bid_flag": "NORMAL", "ask_flag": "NORMAL",
                    },
                })

            def stop(self):
                self.stopped = True

        class Realtime:
            def __init__(self):
                self.subscriber = None

            def subscribe_bid_offer(self, symbol, callback):
                self.subscriber = Subscriber(callback)
                return self.subscriber

        class Investor:
            def __init__(self, realtime):
                self.realtime = realtime
                self.calls = 0

            def RealtimeDataConnection(self):
                self.calls += 1
                return self.realtime

        realtime = Realtime()
        investor = Investor(realtime)
        proxy = SdkEquityProxy(self.config)
        proxy._investor = investor
        proxy._equity = SessionStub()

        result = proxy.get_bid_offer_symbol("AOT")
        second = proxy.get_bid_offer_symbol("AOT")

        self.assertEqual(result["symbol"], "AOT")
        self.assertEqual(second["symbol"], "AOT")
        self.assertEqual(investor.calls, 2)
        self.assertTrue(realtime.subscriber.stopped)


class GatewayHttpTests(unittest.TestCase):
    def setUp(self):
        self.config = BrokerGatewayConfig.from_mapping(uat_env())
        self.equity = FakeEquity()
        self.tempdir = tempfile.TemporaryDirectory()
        self.journal = BrokerJournal(os.path.join(self.tempdir.name, "http-journal.sqlite3"))
        GatewayHandler.config = self.config
        GatewayHandler.service = BrokerService(self.config, self.equity, self.journal)
        self.server = HTTPServer(("127.0.0.1", 0), GatewayHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.journal.close()
        self.tempdir.cleanup()

    def request(self, method, path, *, headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        encoded = json.dumps(body).encode("utf-8") if body is not None else None
        request_headers = dict(headers or {})
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
            request_headers["Content-Length"] = str(len(encoded))
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        connection.close()
        return response.status, payload

    @property
    def auth(self):
        return {"Authorization": f"Bearer {self.config.gateway_token}"}

    def test_health_requires_bearer_and_reports_uat(self):
        status, payload = self.request("GET", "/v1/health")
        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])

        status, payload = self.request("GET", "/v1/health", headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(payload["environment"], "uat")
        self.assertTrue(payload["data"]["ready"])

        self.journal.reserve(
            "health-unresolved-001", "PLACE", "fingerprint",
            request={"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
        )
        status, payload = self.request("GET", "/v1/health", headers=self.auth)
        self.assertEqual(status, 200)
        self.assertFalse(payload["data"]["ready"])
        self.assertEqual(payload["data"]["unresolvedOperations"], 1)

    def test_order_reads_are_minimized_before_leaving_gateway(self):
        status, payload = self.request("GET", "/v1/orders", headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["orders"][0]["orderNo"], "9001")
        self.assertNotIn("accountNo", payload["data"]["orders"][0])

    def test_quote_read_uses_authenticated_gateway_and_is_minimized(self):
        status, payload = self.request("GET", "/v1/quotes/AOT", headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["quote"]["symbol"], "AOT")
        self.assertNotIn("accountNo", payload["data"]["quote"])

    def test_market_snapshot_is_authenticated_and_contains_realtime_top_of_book(self):
        status, payload = self.request("GET", "/v1/market-snapshot/AOT", headers=self.auth)
        self.assertEqual(status, 200)
        quote = payload["data"]["quote"]
        self.assertEqual(quote["bid"], 20.0)
        self.assertEqual(quote["ask"], 20.2)
        self.assertEqual(quote["bidFlag"], "NORMAL")
        self.assertNotIn("accountNo", quote)

    def test_uat_account_schema_is_authenticated_and_contains_no_values(self):
        status, payload = self.request("GET", "/v1/account-schema", headers=self.auth)
        self.assertEqual(status, 200)
        fields = payload["data"]["fields"]
        self.assertIn({"path": "cashBalance", "type": "number"}, fields)
        self.assertNotIn("SECRET-ACCOUNT", str(payload))

    def test_unresolved_journal_endpoint_is_authenticated_and_sanitized(self):
        self.journal.reserve(
            "http-unresolved-001", "PLACE", "private-fingerprint",
            request={"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
        )
        status, payload = self.request("GET", "/v1/journal/unresolved", headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["operations"][0]["requestId"], "http-unresolved-001")
        self.assertEqual(payload["data"]["operations"][0]["order"]["symbol"], "AOT")
        self.assertNotIn("fingerprint", str(payload).lower())
        self.assertNotIn("private-fingerprint", str(payload))

    def test_recovery_candidates_endpoint_is_read_only_and_sanitized(self):
        self.journal.reserve(
            "http-recovery-001", "PLACE", "private-fingerprint",
            request={"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
        )
        status, payload = self.request("GET", "/v1/recovery/candidates", headers=self.auth)
        self.assertEqual(status, 200)
        operation = payload["data"]["operations"][0]
        self.assertEqual(operation["classification"], "EXACTLY_ONE_CANDIDATE")
        self.assertEqual(operation["candidates"][0]["orderNo"], "9001")
        self.assertNotIn("private-fingerprint", str(payload))
        self.assertEqual(len(self.equity.place_calls), 0)

    def test_order_requires_idempotency_and_duplicate_is_not_resubmitted(self):
        self.equity.orders = []
        order = {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20}
        status, payload = self.request("POST", "/v1/orders", headers=self.auth, body=order)
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "INVALID_IDEMPOTENCY_KEY")

        headers = {**self.auth, "X-Idempotency-Key": "http-intent-001"}
        status, first = self.request("POST", "/v1/orders", headers=headers, body=order)
        status2, second = self.request("POST", "/v1/orders", headers=headers, body=order)
        self.assertEqual(status, 200)
        self.assertEqual(status2, 200)
        self.assertFalse(first["data"]["duplicate"])
        self.assertTrue(second["data"]["duplicate"])
        self.assertEqual(len(self.equity.place_calls), 1)

    def test_production_read_only_blocks_order_post_before_broker_call(self):
        readonly = BrokerGatewayConfig.from_mapping(
            uat_env(
                BROKER_ENVIRONMENT="prod",
                SETTRADE_BROKER_ID="023",
                BROKER_PRODUCTION_READ_ONLY="true",
                BROKER_PRODUCTION_ENABLED="false",
                BROKER_PRODUCTION_ACK="",
                BROKER_PRODUCTION_CONFIRMATION="",
                BROKER_CASH_FIELD="",
                BROKER_REQUIRED_ACCOUNT_TYPE="",
            )
        )
        GatewayHandler.config = readonly
        GatewayHandler.service.config = readonly
        try:
            headers = {
                "Authorization": f"Bearer {readonly.gateway_token}",
                "X-Idempotency-Key": "must-never-reach-broker",
            }
            status, payload = self.request(
                "POST",
                "/v1/orders",
                headers=headers,
                body={"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
            )
            self.assertEqual(status, 423)
            self.assertEqual(payload["error"], "PRODUCTION_READ_ONLY")
            self.assertEqual(len(self.equity.place_calls), 0)
        finally:
            GatewayHandler.config = self.config
            GatewayHandler.service.config = self.config

    def test_production_read_only_schema_exposes_names_and_types_not_values(self):
        readonly = BrokerGatewayConfig.from_mapping(
            uat_env(
                BROKER_ENVIRONMENT="prod",
                SETTRADE_BROKER_ID="023",
                BROKER_PRODUCTION_READ_ONLY="true",
                BROKER_PRODUCTION_ENABLED="false",
                BROKER_CASH_FIELD="",
                BROKER_REQUIRED_ACCOUNT_TYPE="",
            )
        )
        GatewayHandler.config = readonly
        GatewayHandler.service.config = readonly
        try:
            headers = {"Authorization": f"Bearer {readonly.gateway_token}"}
            status, payload = self.request("GET", "/v1/account-schema", headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual(payload["data"]["environment"], "prod")
            self.assertIn({"path": "cashBalance", "type": "number"}, payload["data"]["fields"])
            self.assertNotIn("12500.5", str(payload))
            self.assertNotIn("SECRET-ACCOUNT", str(payload))
        finally:
            GatewayHandler.config = self.config
            GatewayHandler.service.config = self.config


if __name__ == "__main__":
    unittest.main()
