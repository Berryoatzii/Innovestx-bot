"""Complete sanitized UAT evidence after a terminal cancel reconciliation."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping

from gateway import load_env_file
from uat_order_cycle import CycleError, _require_uat_payload, build_requester, validate_uat_guard


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--quantity", required=True, type=int)
    parser.add_argument("--price", required=True, type=float)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args()
    gateway_dir = Path(__file__).resolve().parent
    values: dict[str, str] = {}
    load_env_file(
        os.environ.get("BROKER_GATEWAY_ENV_FILE", str(gateway_dir / ".env")), values
    )
    validate_uat_guard(values, args.confirm)
    requester = build_requester(
        f"http://{values.get('BROKER_GATEWAY_HOST', '127.0.0.1')}:{int(values.get('BROKER_GATEWAY_PORT', '8787'))}",
        values.get("BROKER_GATEWAY_TOKEN", ""),
    )
    order = {
        "symbol": args.symbol.upper(), "side": "BUY",
        "quantity": args.quantity, "price": args.price,
    }
    duplicate = _require_uat_payload(
        requester("POST", "/v1/orders", request_id=args.request_id, body=order),
        "DUPLICATE_CHECK",
    )
    if duplicate.get("duplicate") is not True or not str(duplicate.get("orderNo", "")):
        raise CycleError("IDEMPOTENCY_NOT_PROVEN")
    account = _require_uat_payload(
        requester("GET", "/v1/account-snapshot"), "ACCOUNT"
    )
    unresolved = _require_uat_payload(
        requester("GET", "/v1/journal/unresolved"), "UNRESOLVED"
    ).get("operations")
    positions = account.get("portfolio")
    orders = account.get("orders")
    if not isinstance(positions, list) or positions:
        raise CycleError("POSITION_NOT_FLAT")
    if not isinstance(unresolved, list) or unresolved:
        raise CycleError("UNRESOLVED_NOT_CLEARED")
    if not isinstance(orders, list):
        raise CycleError("ORDERS_RESPONSE_UNVERIFIED")
    matches = [
        item for item in orders
        if isinstance(item, Mapping)
        and str(item.get("orderNo", "")) == str(duplicate.get("orderNo", ""))
    ]
    if len(matches) != 1:
        raise CycleError("TERMINAL_ORDER_NOT_UNIQUE")
    item = matches[0]
    if (
        str(item.get("status", "")).strip().casefold()
            not in {"c", "cx", "cancelled", "canceled"}
        or item.get("canCancel") is not False
        or float(item.get("matchedQuantity", 0) or 0) != 0
        or float(item.get("cancelled", 0) or 0) < float(item.get("quantity", 0) or 0)
    ):
        raise CycleError("TERMINAL_CANCEL_NOT_PROVEN")
    evidence = {
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "environment": "uat",
        "requestId": args.request_id,
        "symbol": order["symbol"],
        "side": "BUY",
        "quantity": args.quantity,
        "price": args.price,
        "duplicateProtected": True,
        "readbackStatus": str(item.get("status", ""))[:80],
        "readbackClassification": "TERMINAL_CANCELLED_NO_FILL",
        "matchedQuantity": 0,
        "cancelAttempted": True,
        "cancellationVerified": True,
        "reconciledFromBrokerProof": True,
        "complete": True,
        "realMoney": "REAL-NO-GO",
    }
    evidence_dir = gateway_dir / "uat_evidence"
    evidence_dir.mkdir(exist_ok=True)
    path = evidence_dir / f"{args.request_id}-complete.json"
    path.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print("UAT ORDER CYCLE: COMPLETE")
    print("duplicate protected; matched=0; terminal cancel verified; unresolved=0")
    print(f"sanitized evidence: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
