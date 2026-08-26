"""Reconcile one UAT CANCEL ambiguity from repeated read-only broker proof."""

from __future__ import annotations

import argparse
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from gateway import BrokerGatewayConfig, BrokerJournal, _resolved_journal_path, load_env_file
from uat_order_cycle import CycleError, _require_uat_payload, build_requester, validate_uat_environment


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-id", required=True)
    args = parser.parse_args()
    gateway_dir = Path(__file__).resolve().parent
    env_path = Path(os.environ.get("BROKER_GATEWAY_ENV_FILE", gateway_dir / ".env"))
    values: dict[str, str] = {}
    load_env_file(str(env_path), values)
    validate_uat_environment(values)
    config = BrokerGatewayConfig.from_mapping(values)
    requester = build_requester(
        f"http://{values.get('BROKER_GATEWAY_HOST', '127.0.0.1')}:{int(values.get('BROKER_GATEWAY_PORT', '8787'))}",
        values.get("BROKER_GATEWAY_TOKEN", ""),
    )
    unresolved = _require_uat_payload(
        requester("GET", "/v1/journal/unresolved"), "UNRESOLVED"
    ).get("operations")
    matches = [
        item for item in unresolved or []
        if isinstance(item, Mapping)
        and item.get("requestId") == args.request_id
        and item.get("operation") == "CANCEL"
    ]
    if len(matches) != 1:
        raise CycleError("UNRESOLVED_CANCEL_NOT_UNIQUE")
    order_no = str(matches[0].get("orderNo", ""))
    samples: list[dict[str, Any]] = []
    for index in range(3):
        account = _require_uat_payload(
            requester("GET", "/v1/account-snapshot"), "ACCOUNT"
        )
        positions = account.get("portfolio")
        orders = account.get("orders")
        if not isinstance(positions, list) or not isinstance(orders, list) or positions:
            raise CycleError("ACCOUNT_STATE_NOT_CLEAN")
        candidates = [item for item in orders if str(item.get("orderNo", "")) == order_no]
        if len(candidates) != 1:
            raise CycleError("CANCELLED_ORDER_NOT_UNIQUE")
        item = candidates[0]
        sample = {
            "status": str(item.get("status", "")),
            "canCancel": item.get("canCancel") is True,
            "quantity": float(item.get("quantity", 0) or 0),
            "matchedQuantity": float(item.get("matchedQuantity", 0) or 0),
            "cancelled": float(item.get("cancelled", 0) or 0),
        }
        if (
            sample["status"].strip().casefold() not in {"c", "cx", "cancelled", "canceled"}
            or sample["canCancel"] is not False
            or sample["quantity"] <= 0
            or sample["matchedQuantity"] != 0
            or sample["cancelled"] < sample["quantity"]
        ):
            raise CycleError("TERMINAL_CANCEL_NOT_PROVEN")
        samples.append(sample)
        if index < 2:
            time.sleep(2)
    journal = BrokerJournal(str(_resolved_journal_path(config.journal_path)))
    try:
        journal.resolve_terminal_cancel(
            args.request_id,
            proof={"samples": samples, "checkedAt": datetime.now(timezone.utc).isoformat()},
        )
    finally:
        journal.close()
    print("UAT CANCEL RECONCILIATION: PASS")
    print("matched=0, cancelled=full, canCancel=false; no new order sent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
