"""Explicit, UAT-only order lifecycle test with sanitized evidence output."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from gateway import BrokerPolicyError, load_env_file, parse_board_lot_overrides
from uat_readiness import LOCAL_HOSTS, configure_utf8_output


CONFIRMATION = "SEND_UAT_ORDER_ONLY"
SYMBOL_RE = re.compile(r"^[A-Z0-9._-]{1,20}$")
ORDER_NO_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
SAFE_ERROR_CODE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
PASSIVE_TICKS_BELOW_BID = 1
ORDER_STATUS_READ_ATTEMPTS = 10
ORDER_STATUS_READ_DELAY_SECONDS = 0.25


class CycleError(RuntimeError):
    pass


def safe_cycle_error_code(value: Any) -> str:
    candidate = str(value or "").strip()[:200]
    return candidate if SAFE_ERROR_CODE_RE.fullmatch(candidate) else "CYCLE_ERROR_REDACTED"


def write_failure_evidence(
    evidence_dir: Path,
    *,
    request_id: str,
    symbol: str,
    error: BaseException,
) -> Path:
    """Write only a sanitized UAT failure record; never broker messages."""
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", request_id):
        raise CycleError("INVALID_REQUEST_ID")
    normalized_symbol = str(symbol).upper().strip()
    if not SYMBOL_RE.fullmatch(normalized_symbol):
        raise CycleError("INVALID_SYMBOL")
    evidence_dir.mkdir(exist_ok=True)
    path = evidence_dir / f"{request_id}.json"
    payload = {
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "environment": "uat",
        "requestId": request_id,
        "symbol": normalized_symbol,
        "complete": False,
        "errorCode": safe_cycle_error_code(error),
        "realMoney": "REAL-NO-GO",
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _board_lot_for(values: Mapping[str, str], symbol: str) -> int:
    try:
        default_lot = int(values.get("BROKER_BOARD_LOT", "100") or 0)
        return parse_board_lot_overrides(values).get(symbol, default_lot)
    except (BrokerPolicyError, TypeError, ValueError) as error:
        code = str(error) if isinstance(error, BrokerPolicyError) else "BROKER_BOARD_LOT_INVALID"
        raise CycleError(code) from error


def set_tick_size(price: float) -> float:
    if price < 2:
        return 0.01
    if price < 5:
        return 0.02
    if price < 10:
        return 0.05
    if price < 25:
        return 0.10
    if price < 100:
        return 0.25
    if price < 200:
        return 0.50
    if price < 400:
        return 1.00
    return 2.00


def plan_passive_uat_buy(
    values: Mapping[str, str], quote_payload: Mapping[str, Any], symbol: str
) -> dict[str, Any]:
    """Build a near-touch passive UAT buy that is non-executable at preflight."""
    normalized_symbol = str(symbol).upper().strip()
    _validate_live_quote(quote_payload, normalized_symbol)

    def positive(name: str) -> float | None:
        value = quote_payload.get(name)
        if (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and float(value) > 0
        ):
            return float(value)
        return None

    floor = positive("floor")
    bid = positive("bid")
    ask = positive("ask")
    bid_flag = str(quote_payload.get("bidFlag", "")).upper()
    ask_flag = str(quote_payload.get("askFlag", "")).upper()
    if bid_flag not in {"NORMAL", "1"} or ask_flag not in {"NORMAL", "1"}:
        raise CycleError("BID_OFFER_NOT_NORMAL")
    if bid is None:
        raise CycleError("PASSIVE_PRICE_COULD_MATCH")
    if positive("volume") is None:
        raise CycleError("LIVE_VOLUME_UNAVAILABLE")
    if ask is not None and ask <= bid:
        raise CycleError("BID_OFFER_CROSSED")
    if floor is not None:
        floor_tick = set_tick_size(floor)
        if abs(floor / floor_tick - round(floor / floor_tick)) > 1e-7:
            raise CycleError("QUOTE_FLOOR_NOT_TICK_ALIGNED")

    # A floor-priced order can be roughly 30% away from the market and trigger
    # broker continuity/order-screening warnings.  One valid tick below best
    # bid remains passive at both quote reads while staying near the market.
    price = bid
    for _ in range(PASSIVE_TICKS_BELOW_BID):
        tick_below = set_tick_size(max(price - 1e-8, 0.01))
        price = round(price - tick_below, 2)
    if floor is not None and price < floor:
        raise CycleError("PASSIVE_PRICE_RANGE_TOO_NARROW")
    quantity = _board_lot_for(values, normalized_symbol)
    if quantity <= 0:
        raise CycleError("BROKER_BOARD_LOT_INVALID")
    try:
        max_value = float(values.get("BROKER_MAX_ORDER_VALUE", "0") or 0)
    except (TypeError, ValueError) as error:
        raise CycleError("ORDER_VALUE_LIMIT") from error
    if not math.isfinite(max_value) or max_value <= 0:
        raise CycleError("ORDER_VALUE_LIMIT")
    # Never move the price farther from the market to make an oversized test
    # fit the local cap; that would recreate the screening problem above.
    if quantity * price > max_value:
        raise CycleError("ORDER_VALUE_LIMIT")
    tick = set_tick_size(price)
    if price <= 0 or abs(price / tick - round(price / tick)) > 1e-7:
        raise CycleError("PASSIVE_PRICE_NOT_TICK_ALIGNED")
    if quantity * price > max_value + 1e-7:
        raise CycleError("ORDER_VALUE_LIMIT")
    return {
        "symbol": normalized_symbol,
        "side": "BUY",
        "quantity": quantity,
        "price": price,
    }


def validate_uat_environment(values: Mapping[str, str]) -> None:
    if str(values.get("BROKER_ENVIRONMENT", "")).casefold() != "uat":
        raise CycleError("UAT_ONLY")
    if str(values.get("BROKER_GATEWAY_HOST", "127.0.0.1")).casefold() not in LOCAL_HOSTS:
        raise CycleError("LOCAL_GATEWAY_ONLY")
    if str(values.get("BROKER_PRODUCTION_ENABLED", "false")).casefold() != "false":
        raise CycleError("PRODUCTION_MUST_REMAIN_LOCKED")


def validate_uat_guard(values: Mapping[str, str], confirmation: str) -> None:
    validate_uat_environment(values)
    if confirmation != CONFIRMATION:
        raise CycleError("EXPLICIT_UAT_CONFIRMATION_REQUIRED")


def _validated_order(values: Mapping[str, str], raw: Mapping[str, Any]) -> dict[str, Any]:
    symbol = str(raw.get("symbol", "")).upper().strip()
    side = str(raw.get("side", "")).upper().strip()
    quantity_raw = raw.get("quantity", 0)
    price_raw = raw.get("price", 0)
    if not SYMBOL_RE.fullmatch(symbol):
        raise CycleError("INVALID_SYMBOL")
    if side not in {"BUY", "SELL"}:
        raise CycleError("INVALID_SIDE")
    if isinstance(quantity_raw, bool) or not isinstance(quantity_raw, (int, float)):
        raise CycleError("INVALID_QUANTITY")
    quantity = int(quantity_raw)
    if float(quantity_raw) != quantity or quantity <= 0:
        raise CycleError("INVALID_QUANTITY")
    price = float(price_raw)
    if not math.isfinite(price) or price <= 0:
        raise CycleError("INVALID_PRICE")
    board_lot = _board_lot_for(values, symbol)
    if board_lot <= 0 or quantity % board_lot:
        raise CycleError("BOARD_LOT_REQUIRED")
    max_value = float(values.get("BROKER_MAX_ORDER_VALUE", "0") or 0)
    if max_value <= 0 or quantity * price > max_value:
        raise CycleError("ORDER_VALUE_LIMIT")
    return {"symbol": symbol, "side": side, "quantity": quantity, "price": price}


def _require_uat_payload(payload: Mapping[str, Any], label: str) -> Mapping[str, Any]:
    if payload.get("environment") != "uat":
        raise CycleError(f"{label}_ENVIRONMENT_MISMATCH")
    if payload.get("ok") is not True:
        error = safe_cycle_error_code(payload.get("error", "UNKNOWN"))
        raise CycleError(f"{label}_FAILED:{error}")
    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise CycleError(f"{label}_INVALID_RESPONSE")
    return data


def _validate_live_quote(quote_payload: Mapping[str, Any], symbol: str) -> None:
    if str(quote_payload.get("symbol", "")).upper() != symbol:
        raise CycleError("QUOTE_SYMBOL_MISMATCH")
    market_status = str(quote_payload.get("marketStatus", "")).casefold()
    if market_status not in {"open", "open1", "open2"}:
        raise CycleError("MARKET_NOT_OPEN")
    prices = (quote_payload.get("last"), quote_payload.get("bid"), quote_payload.get("ask"))
    if not any(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        and math.isfinite(float(value)) and float(value) > 0
        for value in prices
    ):
        raise CycleError("LIVE_QUOTE_UNAVAILABLE")


def _validate_passive_order_quote(
    quote_payload: Mapping[str, Any], order: Mapping[str, Any]
) -> None:
    floor = quote_payload.get("floor")
    bid = quote_payload.get("bid")
    ask = quote_payload.get("ask")
    bid_is_valid = (
        isinstance(bid, (int, float))
        and not isinstance(bid, bool)
        and math.isfinite(float(bid))
        and float(bid) > 0
    )
    ask_is_valid = (
        isinstance(ask, (int, float))
        and not isinstance(ask, bool)
        and math.isfinite(float(ask))
        and float(ask) > 0
    )
    if not bid_is_valid:
        raise CycleError("PASSIVE_PRICE_CHANGED")
    if str(quote_payload.get("bidFlag", "")).upper() not in {"NORMAL", "1"}:
        raise CycleError("PASSIVE_PRICE_CHANGED")
    if str(quote_payload.get("askFlag", "")).upper() not in {"NORMAL", "1"}:
        raise CycleError("PASSIVE_PRICE_CHANGED")
    price = float(order["price"])
    floor_is_valid = (
        isinstance(floor, (int, float))
        and not isinstance(floor, bool)
        and math.isfinite(float(floor))
        and float(floor) > 0
    )
    if price >= float(bid) or (ask_is_valid and price >= float(ask)):
        raise CycleError("PASSIVE_PRICE_CHANGED")
    if floor_is_valid and price < float(floor):
        raise CycleError("PASSIVE_PRICE_CHANGED")


def _classify_order_status(order: Mapping[str, Any]) -> str:
    """Classify Settrade's order state without treating submission as success."""
    status = str(order.get("status", "")).strip().upper()
    quantity = float(order.get("quantity", 0) or 0)
    matched = float(order.get("matchedQuantity", 0) or 0)
    if matched > 0 or status in {"M", "MP", "MATCHED", "FILLED", "PARTIAL", "PARTIALLY_FILLED"}:
        if quantity > 0 and matched >= quantity or status in {"M", "MATCHED", "FILLED"}:
            return "FULL_FILL"
        return "PARTIAL_FILL"
    if status in {"C", "CANCELLED", "CANCELED", "R", "REJECTED", "E", "EXPIRED"}:
        return "TERMINAL_NO_FILL"
    if order.get("canCancel") is True:
        return "OPEN"
    if status in {"S", "SX", "OPEN", "PENDING", "ACCEPTED", "SUBMITTED", "WAITING"}:
        return "PENDING"
    return "UNKNOWN"


def run_uat_cycle(
    values: Mapping[str, str],
    raw_order: Mapping[str, Any],
    confirmation: str,
    requester: Callable[..., Mapping[str, Any]],
    *,
    request_id: str | None = None,
    passive_only: bool = False,
    quote_path_prefix: str = "/v1/quotes/",
    status_read_attempts: int = ORDER_STATUS_READ_ATTEMPTS,
    sleeper: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    validate_uat_guard(values, confirmation)
    order = _validated_order(values, raw_order)
    request_id = request_id or f"uat-cycle-{uuid.uuid4().hex}"
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", request_id):
        raise CycleError("INVALID_REQUEST_ID")

    health = _require_uat_payload(requester("GET", "/v1/health"), "HEALTH")
    if health.get("ready") is not True:
        raise CycleError("GATEWAY_NOT_READY")
    quote_data = _require_uat_payload(
        requester("GET", f"{quote_path_prefix}{quote(order['symbol'])}"), "QUOTE"
    )
    quote_payload = quote_data.get("quote") if isinstance(quote_data.get("quote"), Mapping) else quote_data
    _validate_live_quote(quote_payload, order["symbol"])
    if passive_only:
        _validate_passive_order_quote(quote_payload, order)

    first = _require_uat_payload(
        requester("POST", "/v1/orders", request_id=request_id, body=order), "PLACE"
    )
    order_no = str(first.get("orderNo", ""))
    if not ORDER_NO_RE.fullmatch(order_no):
        raise CycleError("PLACE_WITHOUT_VALID_ORDER_NO")

    if status_read_attempts <= 0 or status_read_attempts > 40:
        raise CycleError("INVALID_STATUS_READ_ATTEMPTS")
    status: Mapping[str, Any] = {}
    classification = "UNKNOWN"
    for attempt in range(status_read_attempts):
        status_data = _require_uat_payload(
            requester("GET", f"/v1/orders/{quote(order_no)}"), "ORDER_READBACK"
        )
        status = status_data.get("order") if isinstance(status_data.get("order"), Mapping) else {}
        classification = _classify_order_status(status)
        if classification == "PARTIAL_FILL" and status.get("canCancel") is not True:
            if attempt + 1 < status_read_attempts:
                sleeper(ORDER_STATUS_READ_DELAY_SECONDS)
                continue
            raise CycleError("PARTIAL_FILL_REMAINDER_UNRESOLVED")
        if classification != "PENDING":
            break
        if attempt + 1 < status_read_attempts:
            sleeper(ORDER_STATUS_READ_DELAY_SECONDS)
    if classification in {"PENDING", "UNKNOWN"}:
        raise CycleError("ORDER_STATUS_UNRESOLVED")

    matched_quantity = float(status.get("matchedQuantity", 0) or 0)
    duplicate_protected = False
    cancellation_verified = False
    cancel_attempted = False
    if classification in {"OPEN", "PARTIAL_FILL"} and status.get("canCancel") is True:
        cancel_attempted = True
        cancel_id = f"{request_id}-cancel"
        cancelled = _require_uat_payload(
            requester(
                "POST", f"/v1/orders/{quote(order_no)}/cancel",
                request_id=cancel_id, body={},
            ),
            "CANCEL",
        )
        cancellation_verified = cancelled.get("cancellationVerified") is True
        if not cancellation_verified:
            raise CycleError("CANCEL_NOT_VERIFIED")

    # Prove the local idempotency journal only after the first order is known
    # to be open, unfilled, and successfully cancelled.  A fill or unknown
    # state must not trigger any second place request, even to the gateway.
    if classification == "OPEN" and matched_quantity == 0 and cancellation_verified:
        duplicate = _require_uat_payload(
            requester("POST", "/v1/orders", request_id=request_id, body=order),
            "DUPLICATE_CHECK",
        )
        duplicate_protected = (
            duplicate.get("duplicate") is True
            and str(duplicate.get("orderNo", "")) == order_no
        )
        if not duplicate_protected:
            raise CycleError("IDEMPOTENCY_NOT_PROVEN")

    return {
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "environment": "uat",
        "requestId": request_id,
        "orderNo": order_no,
        "symbol": order["symbol"],
        "side": order["side"],
        "quantity": order["quantity"],
        "price": order["price"],
        "duplicateProtected": duplicate_protected,
        "readbackStatus": str(status.get("status", ""))[:80],
        "readbackClassification": classification,
        "matchedQuantity": matched_quantity,
        "cancelAttempted": cancel_attempted,
        "cancellationVerified": cancellation_verified,
        "complete": (
            classification == "OPEN"
            and matched_quantity == 0
            and duplicate_protected
            and cancellation_verified
        ),
        "realMoney": "REAL-NO-GO",
    }


def run_passive_uat_cycle(
    values: Mapping[str, str],
    symbol: str,
    confirmation: str,
    requester: Callable[..., Mapping[str, Any]],
    *,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Plan from one read, then require a second non-executable quote before POST."""
    validate_uat_guard(values, confirmation)
    health = _require_uat_payload(requester("GET", "/v1/health"), "HEALTH")
    if health.get("ready") is not True:
        raise CycleError("GATEWAY_NOT_READY")
    normalized_symbol = str(symbol).upper().strip()
    quote_data = _require_uat_payload(
        requester("GET", f"/v1/market-snapshot/{quote(normalized_symbol)}"), "QUOTE"
    )
    quote_payload = (
        quote_data.get("quote")
        if isinstance(quote_data.get("quote"), Mapping)
        else quote_data
    )
    order = plan_passive_uat_buy(values, quote_payload, normalized_symbol)
    return run_uat_cycle(
        values,
        order,
        confirmation,
        requester,
        request_id=request_id,
        passive_only=True,
        quote_path_prefix="/v1/market-snapshot/",
    )


def plan_passive_uat_order(
    values: Mapping[str, str],
    symbol: str,
    requester: Callable[..., Mapping[str, Any]],
) -> dict[str, Any]:
    """Read and validate one passive UAT plan without authorizing any mutation."""
    validate_uat_environment(values)
    health = _require_uat_payload(requester("GET", "/v1/health"), "HEALTH")
    if health.get("ready") is not True:
        raise CycleError("GATEWAY_NOT_READY")
    normalized_symbol = str(symbol).upper().strip()
    if not SYMBOL_RE.fullmatch(normalized_symbol):
        raise CycleError("INVALID_SYMBOL")
    quote_data = _require_uat_payload(
        requester("GET", f"/v1/market-snapshot/{quote(normalized_symbol)}"), "QUOTE"
    )
    quote_payload = (
        quote_data.get("quote")
        if isinstance(quote_data.get("quote"), Mapping)
        else quote_data
    )
    order = plan_passive_uat_buy(values, quote_payload, normalized_symbol)
    return {
        "environment": "uat",
        "order": order,
        "market": {
            "status": quote_payload.get("marketStatus"),
            "last": quote_payload.get("last"),
            "bid": quote_payload.get("bid"),
            "ask": quote_payload.get("ask"),
            "floor": quote_payload.get("floor"),
            "volume": quote_payload.get("volume"),
        },
        "mutationAuthorized": False,
        "realMoney": "REAL-NO-GO",
    }


def build_requester(base_url: str, token: str) -> Callable[..., Mapping[str, Any]]:
    def request(method: str, path: str, *, request_id: str = "", body: Any = None) -> Mapping[str, Any]:
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        encoded = None
        if method == "POST":
            headers["Content-Type"] = "application/json"
            headers["X-Idempotency-Key"] = request_id
            encoded = json.dumps(body if body is not None else {}).encode("utf-8")
        req = Request(f"{base_url}{path}", data=encoded, method=method, headers=headers)
        try:
            with urlopen(req, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except Exception:
                payload = {"environment": "uat", "ok": False, "error": f"HTTP_{error.code}"}
        except Exception as error:
            raise CycleError(f"GATEWAY_UNREACHABLE:{type(error).__name__}") from error
        if not isinstance(payload, Mapping):
            raise CycleError("GATEWAY_INVALID_JSON")
        return payload
    return request


def main(argv: list[str] | None = None) -> int:
    configure_utf8_output(sys.stdout)
    configure_utf8_output(sys.stderr)
    parser = argparse.ArgumentParser(description="Settrade UAT order lifecycle test only")
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--side", choices=("BUY", "SELL"))
    parser.add_argument("--quantity", type=int)
    parser.add_argument("--price", type=float)
    parser.add_argument(
        "--passive-buy", action="store_true",
        help="derive one UAT board lot one tick below verified bid and recheck before POST",
    )
    parser.add_argument(
        "--plan-only", action="store_true",
        help="read and print a passive UAT plan without sending any POST",
    )
    parser.add_argument("--confirm")
    args = parser.parse_args(argv)
    if args.plan_only and args.passive_buy:
        parser.error("--plan-only and --passive-buy are mutually exclusive")
    if not args.plan_only and not args.passive_buy and (
        args.side is None or args.quantity is None or args.price is None
    ):
        parser.error("--side, --quantity and --price are required without --passive-buy")
    if not args.plan_only and args.confirm is None:
        parser.error("--confirm is required for a UAT mutation test")

    gateway_dir = Path(__file__).resolve().parent
    mutation_request_id = None if args.plan_only else f"uat-cycle-{uuid.uuid4().hex}"
    env_path = Path(os.environ.get("BROKER_GATEWAY_ENV_FILE", gateway_dir / ".env"))
    values: dict[str, str] = {}
    load_env_file(str(env_path), values)
    try:
        validate_uat_environment(values)
        token = values.get("BROKER_GATEWAY_TOKEN", "")
        if not token:
            raise CycleError("UAT_GATEWAY_TOKEN_MISSING")
        host = values.get("BROKER_GATEWAY_HOST", "127.0.0.1")
        port = int(values.get("BROKER_GATEWAY_PORT", "8787"))
        display_host = f"[{host}]" if host == "::1" else host
        requester = build_requester(f"http://{display_host}:{port}", token)
        if args.plan_only:
            result = plan_passive_uat_order(values, args.symbol, requester)
        elif args.passive_buy:
            result = run_passive_uat_cycle(
                values, args.symbol, args.confirm, requester,
                request_id=mutation_request_id,
            )
        else:
            result = run_uat_cycle(
                values,
                {
                    "symbol": args.symbol,
                    "side": args.side,
                    "quantity": args.quantity,
                    "price": args.price,
                },
                args.confirm,
                requester,
                request_id=mutation_request_id,
            )
    except CycleError as error:
        if mutation_request_id is not None:
            try:
                evidence_path = write_failure_evidence(
                    gateway_dir / "uat_evidence",
                    request_id=mutation_request_id,
                    symbol=args.symbol,
                    error=error,
                )
                print(f"Sanitized failure evidence: {evidence_path}", file=sys.stderr)
            except Exception:
                print("UAT failure evidence could not be written safely.", file=sys.stderr)
        print(f"UAT ORDER TEST: ไม่ผ่าน — {error}", file=sys.stderr)
        return 1

    if args.plan_only:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    evidence_dir = gateway_dir / "uat_evidence"
    evidence_dir.mkdir(exist_ok=True)
    evidence_path = evidence_dir / f"{result['requestId']}.json"
    evidence_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"UAT ORDER TEST: {'ผ่านครบ' if result['complete'] else 'ผ่านบางส่วน — ยังยืนยันการยกเลิกไม่ได้'}")
    print(f"Order: {result['side']} {result['symbol']} {result['quantity']} @ {result['price']}")
    print(f"Order No: {result['orderNo']}")
    print(f"ป้องกันออเดอร์ซ้ำ: {'ผ่าน' if result['duplicateProtected'] else 'ไม่ผ่าน'}")
    print(f"ยกเลิกยืนยันแล้ว: {'ผ่าน' if result['cancellationVerified'] else 'ไม่ได้ทดสอบ/ไม่ผ่าน'}")
    print(f"หลักฐานแบบไม่มีข้อมูลลับ: {evidence_path}")
    print("เงินจริงยังล็อก: REAL-NO-GO")
    return 0 if result["complete"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
