import json
import tempfile
import unittest
from pathlib import Path

from uat_order_cycle import (
    CycleError,
    plan_passive_uat_order,
    plan_passive_uat_buy,
    run_passive_uat_cycle,
    run_uat_cycle,
    safe_cycle_error_code,
    validate_uat_guard,
    write_failure_evidence,
)


def uat_values(**overrides):
    values = {
        "BROKER_ENVIRONMENT": "uat",
        "BROKER_GATEWAY_HOST": "127.0.0.1",
        "BROKER_PRODUCTION_ENABLED": "false",
        "BROKER_BOARD_LOT": "100",
        "BROKER_MAX_ORDER_VALUE": "3000",
    }
    values.update(overrides)
    return values


class UatOrderCycleTests(unittest.TestCase):
    def test_failure_evidence_redacts_free_form_messages(self):
        self.assertEqual(
            safe_cycle_error_code("bad message containing PIN=123456"),
            "CYCLE_ERROR_REDACTED",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = write_failure_evidence(
                Path(directory),
                request_id="uat-cycle-failure-001",
                symbol="TTB",
                error=CycleError(
                    "PLACE_FAILED:BROKER_PLACE_REJECTED:SettradeError:422:PRICE_WARNING"
                ),
            )
            payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertFalse(payload["complete"])
        self.assertEqual(payload["environment"], "uat")
        self.assertEqual(
            payload["errorCode"],
            "PLACE_FAILED:BROKER_PLACE_REJECTED:SettradeError:422:PRICE_WARNING",
        )
        self.assertNotIn("PIN", str(payload))

    def test_plan_only_reads_health_and_quote_without_confirmation_or_post(self):
        calls = []

        def requester(method, path, *, request_id="", body=None):
            calls.append((method, path))
            if path == "/v1/health":
                return {"ok": True, "environment": "uat", "data": {"ready": True}}
            if path == "/v1/market-snapshot/PTT":
                return {
                    "ok": True, "environment": "uat",
                    "data": {"quote": {
                        "symbol": "PTT", "marketStatus": "Open", "last": 26.5,
                        "bid": 26.25, "ask": 26.50, "floor": 18.60, "volume": 1000,
                        "bidFlag": "NORMAL", "askFlag": "NORMAL",
                    }},
                }
            raise AssertionError((method, path))

        result = plan_passive_uat_order(uat_values(), "PTT", requester)

        self.assertEqual(result["order"], {
            "symbol": "PTT", "side": "BUY", "quantity": 100, "price": 26.0,
        })
        self.assertEqual(result["market"], {
            "status": "Open", "last": 26.5, "bid": 26.25, "ask": 26.5,
            "floor": 18.6, "volume": 1000,
        })
        self.assertFalse(result["mutationAuthorized"])
        self.assertEqual(calls, [("GET", "/v1/health"), ("GET", "/v1/market-snapshot/PTT")])
        self.assertFalse(any(method == "POST" for method, _path in calls))

    def test_plan_only_keeps_production_and_remote_gateway_locked(self):
        for values, expected in (
            (uat_values(BROKER_ENVIRONMENT="prod"), "UAT_ONLY"),
            (uat_values(BROKER_GATEWAY_HOST="example.com"), "LOCAL_GATEWAY_ONLY"),
            (uat_values(BROKER_PRODUCTION_ENABLED="true"), "PRODUCTION_MUST_REMAIN_LOCKED"),
        ):
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(CycleError, expected):
                    plan_passive_uat_order(values, "PTT", lambda *_args, **_kwargs: None)

    def test_passive_cycle_rechecks_price_before_any_order_post(self):
        calls = []
        quote_count = 0

        def requester(method, path, *, request_id="", body=None):
            nonlocal quote_count
            calls.append((method, path, body))
            if path == "/v1/health":
                return {"ok": True, "environment": "uat", "data": {"ready": True}}
            if path == "/v1/market-snapshot/PTT":
                quote_count += 1
                floor = 18.60 if quote_count == 1 else 26.25
                return {
                    "ok": True, "environment": "uat",
                    "data": {"quote": {
                        "symbol": "PTT", "marketStatus": "Open", "last": 26.5,
                        "bid": 26.25, "ask": 26.50, "floor": floor, "volume": 1000,
                        "bidFlag": "NORMAL", "askFlag": "NORMAL",
                    }},
                }
            raise AssertionError("order endpoint must not be reached")

        with self.assertRaisesRegex(CycleError, "PASSIVE_PRICE_CHANGED"):
            run_passive_uat_cycle(
                uat_values(), "PTT", "SEND_UAT_ORDER_ONLY", requester,
                request_id="uat-passive-test-001",
            )
        self.assertFalse(any(method == "POST" for method, _path, _body in calls))

    def test_passive_uat_plan_uses_verified_floor_and_exact_board_lot(self):
        quote = {
            "symbol": "PTT", "marketStatus": "Open1", "last": 26.5,
            "bid": 26.25, "ask": 26.50, "floor": 18.60, "volume": 1000,
            "bidFlag": "NORMAL", "askFlag": "NORMAL",
        }
        plan = plan_passive_uat_buy(uat_values(), quote, "PTT")
        self.assertEqual(plan, {"symbol": "PTT", "side": "BUY", "quantity": 100, "price": 26.0})

        no_floor = plan_passive_uat_buy(uat_values(), {**quote, "floor": None}, "PTT")
        self.assertEqual(no_floor["price"], 26.0)

        with self.assertRaisesRegex(CycleError, "ORDER_VALUE_LIMIT"):
            plan_passive_uat_buy(
                uat_values(),
                {**quote, "bid": 33.0, "ask": 35.5, "floor": None},
                "PTT",
            )

        dr = dict(quote, symbol="NVDA80", last=34.75, bid=34.50, ask=34.75, floor=24.50)
        plan = plan_passive_uat_buy(
            uat_values(BROKER_BOARD_LOT_OVERRIDES_JSON='{"NVDA80":1}'), dr, "NVDA80"
        )
        self.assertEqual(plan["quantity"], 1)
        self.assertEqual(plan["price"], 34.25)

        one_sided = plan_passive_uat_buy(
            uat_values(), {**quote, "floor": None, "bid": 29.75, "ask": 0.0}, "PTT"
        )
        self.assertEqual(one_sided, {
            "symbol": "PTT", "side": "BUY", "quantity": 100, "price": 29.5,
        })

    def test_passive_uat_plan_fails_closed_on_unverified_or_executable_price(self):
        base = {
            "symbol": "PTT", "marketStatus": "Open", "last": 26.5,
            "bid": 26.25, "ask": 26.50, "floor": 18.60, "volume": 1000,
            "bidFlag": "NORMAL", "askFlag": "NORMAL",
        }
        cases = (
            ({**base, "floor": 26.25}, "PASSIVE_PRICE_RANGE_TOO_NARROW"),
            ({**base, "floor": 18.63}, "QUOTE_FLOOR_NOT_TICK_ALIGNED"),
            ({**base, "volume": 0}, "LIVE_VOLUME_UNAVAILABLE"),
            ({**base, "bidFlag": "ATO"}, "BID_OFFER_NOT_NORMAL"),
            ({**base, "floor": None, "bid": 0.0, "ask": 26.50}, "PASSIVE_PRICE_COULD_MATCH"),
            ({**base, "bid": 26.50, "ask": 26.25}, "BID_OFFER_CROSSED"),
        )
        for quote, expected in cases:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(CycleError, expected):
                    plan_passive_uat_buy(uat_values(), quote, "PTT")

    def test_guard_rejects_production_remote_and_missing_confirmation(self):
        with self.assertRaisesRegex(CycleError, "UAT_ONLY"):
            validate_uat_guard(uat_values(BROKER_ENVIRONMENT="prod"), "SEND_UAT_ORDER_ONLY")
        with self.assertRaisesRegex(CycleError, "LOCAL_GATEWAY_ONLY"):
            validate_uat_guard(uat_values(BROKER_GATEWAY_HOST="example.com"), "SEND_UAT_ORDER_ONLY")
        with self.assertRaisesRegex(CycleError, "CONFIRMATION_REQUIRED"):
            validate_uat_guard(uat_values(), "yes")

    def test_cycle_proves_duplicate_protection_and_cancels_open_order(self):
        calls = []

        def requester(method, path, *, request_id="", body=None):
            calls.append((method, path, request_id, body))
            if path == "/v1/health":
                return {"ok": True, "environment": "uat", "data": {"ready": True}}
            if path == "/v1/quotes/AOT":
                return {"ok": True, "environment": "uat", "data": {"quote": {"symbol": "AOT", "marketStatus": "Open", "last": 20}}}
            if method == "POST" and path == "/v1/orders":
                duplicate = len([call for call in calls if call[0] == "POST" and call[1] == "/v1/orders"]) > 1
                return {
                    "ok": True, "environment": "uat",
                    "data": {"orderNo": "9001", "duplicate": duplicate, "canCancel": True},
                }
            if method == "GET" and path == "/v1/orders/9001":
                return {
                    "ok": True, "environment": "uat",
                    "data": {"order": {"orderNo": "9001", "status": "Pending", "canCancel": True}},
                }
            if method == "POST" and path == "/v1/orders/9001/cancel":
                return {
                    "ok": True, "environment": "uat",
                    "data": {"orderNo": "9001", "cancellationVerified": True},
                }
            raise AssertionError((method, path))

        result = run_uat_cycle(
            uat_values(),
            {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
            "SEND_UAT_ORDER_ONLY",
            requester,
            request_id="uat-cycle-test-001",
        )

        self.assertEqual(result["environment"], "uat")
        self.assertTrue(result["duplicateProtected"])
        self.assertTrue(result["cancellationVerified"])
        self.assertTrue(result["complete"])
        place_calls = [call for call in calls if call[0] == "POST" and call[1] == "/v1/orders"]
        self.assertEqual(len(place_calls), 2)
        self.assertEqual(place_calls[0][2], place_calls[1][2])
        self.assertEqual(place_calls[0][3], place_calls[1][3])
        self.assertNotIn("account", str(result).lower())

    def test_cycle_polls_submitted_state_then_cancels_before_duplicate_check(self):
        calls = []
        reads = 0

        def requester(method, path, *, request_id="", body=None):
            nonlocal reads
            calls.append((method, path, request_id, body))
            if path == "/v1/health":
                return {"ok": True, "environment": "uat", "data": {"ready": True}}
            if path == "/v1/quotes/AOT":
                return {"ok": True, "environment": "uat", "data": {"quote": {
                    "symbol": "AOT", "marketStatus": "Open", "last": 20,
                }}}
            if method == "POST" and path == "/v1/orders":
                duplicate = len([call for call in calls if call[0] == "POST" and call[1] == "/v1/orders"]) > 1
                return {"ok": True, "environment": "uat", "data": {
                    "orderNo": "9001", "duplicate": duplicate,
                }}
            if method == "GET" and path == "/v1/orders/9001":
                reads += 1
                return {"ok": True, "environment": "uat", "data": {"order": {
                    "orderNo": "9001", "status": "S" if reads == 1 else "SX",
                    "canCancel": reads > 1, "quantity": 100, "matchedQuantity": 0,
                }}}
            if method == "POST" and path == "/v1/orders/9001/cancel":
                return {"ok": True, "environment": "uat", "data": {
                    "orderNo": "9001", "cancellationVerified": True,
                }}
            raise AssertionError((method, path))

        result = run_uat_cycle(
            uat_values(),
            {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
            "SEND_UAT_ORDER_ONLY",
            requester,
            request_id="uat-cycle-poll-001",
            sleeper=lambda _seconds: None,
        )
        self.assertTrue(result["complete"])
        self.assertEqual(reads, 2)
        ordered_paths = [(method, path) for method, path, _request_id, _body in calls]
        self.assertLess(
            ordered_paths.index(("POST", "/v1/orders/9001/cancel")),
            len(ordered_paths) - 1,
        )
        self.assertEqual(ordered_paths[-1], ("POST", "/v1/orders"))

    def test_full_fill_never_sends_duplicate_or_cancel(self):
        calls = []

        def requester(method, path, *, request_id="", body=None):
            calls.append((method, path))
            if path == "/v1/health":
                return {"ok": True, "environment": "uat", "data": {"ready": True}}
            if path == "/v1/quotes/AOT":
                return {"ok": True, "environment": "uat", "data": {"quote": {
                    "symbol": "AOT", "marketStatus": "Open", "last": 20,
                }}}
            if method == "POST" and path == "/v1/orders":
                return {"ok": True, "environment": "uat", "data": {"orderNo": "9001"}}
            if method == "GET" and path == "/v1/orders/9001":
                return {"ok": True, "environment": "uat", "data": {"order": {
                    "orderNo": "9001", "status": "M", "quantity": 100,
                    "matchedQuantity": 100, "canCancel": False,
                }}}
            raise AssertionError((method, path))

        result = run_uat_cycle(
            uat_values(),
            {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
            "SEND_UAT_ORDER_ONLY",
            requester,
            request_id="uat-cycle-fill-001",
        )
        self.assertFalse(result["complete"])
        self.assertEqual(result["readbackClassification"], "FULL_FILL")
        self.assertEqual(calls.count(("POST", "/v1/orders")), 1)
        self.assertFalse(any(path.endswith("/cancel") for _method, path in calls))

    def test_partial_fill_waits_to_cancel_remainder_and_never_checks_duplicate(self):
        calls = []
        reads = 0

        def requester(method, path, *, request_id="", body=None):
            nonlocal reads
            calls.append((method, path))
            if path == "/v1/health":
                return {"ok": True, "environment": "uat", "data": {"ready": True}}
            if path == "/v1/quotes/AOT":
                return {"ok": True, "environment": "uat", "data": {"quote": {
                    "symbol": "AOT", "marketStatus": "Open", "last": 20,
                }}}
            if method == "POST" and path == "/v1/orders":
                return {"ok": True, "environment": "uat", "data": {"orderNo": "9001"}}
            if method == "GET" and path == "/v1/orders/9001":
                reads += 1
                return {"ok": True, "environment": "uat", "data": {"order": {
                    "orderNo": "9001", "status": "MP", "quantity": 100,
                    "matchedQuantity": 10, "canCancel": reads > 1,
                }}}
            if method == "POST" and path == "/v1/orders/9001/cancel":
                return {"ok": True, "environment": "uat", "data": {
                    "orderNo": "9001", "cancellationVerified": True,
                }}
            raise AssertionError((method, path))

        result = run_uat_cycle(
            uat_values(),
            {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
            "SEND_UAT_ORDER_ONLY",
            requester,
            request_id="uat-cycle-partial-001",
            sleeper=lambda _seconds: None,
        )
        self.assertFalse(result["complete"])
        self.assertTrue(result["cancellationVerified"])
        self.assertEqual(result["readbackClassification"], "PARTIAL_FILL")
        self.assertEqual(result["matchedQuantity"], 10)
        self.assertEqual(calls.count(("POST", "/v1/orders")), 1)

    def test_order_policy_is_checked_before_any_request(self):
        calls = []
        requester = lambda *args, **kwargs: calls.append((args, kwargs))
        with self.assertRaisesRegex(CycleError, "BOARD_LOT_REQUIRED"):
            run_uat_cycle(
                uat_values(),
                {"symbol": "AOT", "side": "BUY", "quantity": 50, "price": 20},
                "SEND_UAT_ORDER_ONLY",
                requester,
            )
        self.assertEqual(calls, [])

    def test_explicit_symbol_board_lot_override_does_not_change_other_symbols(self):
        values = uat_values(BROKER_BOARD_LOT_OVERRIDES_JSON='{"NVDA80":1}')
        calls = []
        def requester(*args, **kwargs):
            calls.append((args, kwargs))
            return {"ok": False, "environment": "uat", "error": "test-stop"}

        # The override lets validation proceed to the read-only health check.
        with self.assertRaisesRegex(CycleError, "HEALTH_FAILED"):
            run_uat_cycle(
                values,
                {"symbol": "NVDA80", "side": "BUY", "quantity": 1, "price": 20},
                "SEND_UAT_ORDER_ONLY",
                requester,
            )
        self.assertEqual(len(calls), 1)

        calls.clear()
        with self.assertRaisesRegex(CycleError, "BOARD_LOT_REQUIRED"):
            run_uat_cycle(
                values,
                {"symbol": "AOT", "side": "BUY", "quantity": 1, "price": 20},
                "SEND_UAT_ORDER_ONLY",
                requester,
            )
        self.assertEqual(calls, [])

    def test_malformed_board_lot_override_is_rejected_before_network(self):
        calls = []
        with self.assertRaisesRegex(CycleError, "BROKER_BOARD_LOT_OVERRIDES_INVALID"):
            run_uat_cycle(
                uat_values(BROKER_BOARD_LOT_OVERRIDES_JSON='{"NVDA80":true}'),
                {"symbol": "NVDA80", "side": "BUY", "quantity": 1, "price": 20},
                "SEND_UAT_ORDER_ONLY",
                lambda *args, **kwargs: calls.append((args, kwargs)),
            )
        self.assertEqual(calls, [])

    def test_cycle_does_not_claim_complete_when_order_cannot_be_cancelled(self):
        def requester(method, path, *, request_id="", body=None):
            if path == "/v1/health":
                return {"ok": True, "environment": "uat", "data": {"ready": True}}
            if path == "/v1/quotes/AOT":
                return {"ok": True, "environment": "uat", "data": {"quote": {"symbol": "AOT", "marketStatus": "Open", "last": 20}}}
            if method == "POST" and path == "/v1/orders":
                return {
                    "ok": True, "environment": "uat",
                    "data": {"orderNo": "9001", "duplicate": request_id.endswith("duplicate")},
                }
            if method == "GET" and path == "/v1/orders/9001":
                return {
                    "ok": True, "environment": "uat",
                    "data": {"order": {"orderNo": "9001", "status": "Matched", "canCancel": False}},
                }
            raise AssertionError((method, path))

        # Keep the same key while letting this stub distinguish the second call.
        place_count = 0
        def counted(method, path, *, request_id="", body=None):
            nonlocal place_count
            if method == "POST" and path == "/v1/orders":
                place_count += 1
                payload = requester(method, path, request_id=request_id, body=body)
                payload["data"]["duplicate"] = place_count == 2
                return payload
            return requester(method, path, request_id=request_id, body=body)

        result = run_uat_cycle(
            uat_values(),
            {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
            "SEND_UAT_ORDER_ONLY",
            counted,
            request_id="uat-cycle-test-002",
        )
        self.assertFalse(result["complete"])
        self.assertFalse(result["cancellationVerified"])

    def test_cycle_refuses_closed_market_or_missing_price_before_order(self):
        for quote, expected in (
            ({"symbol": "AOT", "marketStatus": "Close", "last": 20}, "MARKET_NOT_OPEN"),
            ({"symbol": "AOT", "marketStatus": "Pre-Open", "last": 20}, "MARKET_NOT_OPEN"),
            ({"symbol": "AOT", "marketStatus": "Intermission", "last": 20}, "MARKET_NOT_OPEN"),
            ({"symbol": "AOT", "marketStatus": "Open", "last": None}, "LIVE_QUOTE_UNAVAILABLE"),
        ):
            calls = []

            def requester(method, path, *, request_id="", body=None):
                calls.append((method, path))
                if path == "/v1/health":
                    return {"ok": True, "environment": "uat", "data": {"ready": True}}
                if path == "/v1/quotes/AOT":
                    return {"ok": True, "environment": "uat", "data": {"quote": quote}}
                raise AssertionError("order endpoint must not be reached")

            with self.assertRaisesRegex(CycleError, expected):
                run_uat_cycle(
                    uat_values(),
                    {"symbol": "AOT", "side": "BUY", "quantity": 100, "price": 20},
                    "SEND_UAT_ORDER_ONLY",
                    requester,
                )
            self.assertFalse(any(method == "POST" for method, _path in calls))


if __name__ == "__main__":
    unittest.main()
