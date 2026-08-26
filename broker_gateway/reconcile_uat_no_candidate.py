"""Resolve one UAT PLACE ambiguity only after repeated read-only broker proof."""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from gateway import (
    BrokerGatewayConfig,
    BrokerJournal,
    BrokerPolicyError,
    _resolved_journal_path,
    load_env_file,
)
from uat_order_cycle import (
    CONFIRMATION,
    CycleError,
    _require_uat_payload,
    build_requester,
    validate_uat_guard,
)
from uat_readiness import configure_utf8_output


def collect_no_candidate_proof(
    requester: Any,
    request_id: str,
    *,
    sample_count: int = 3,
    delay_seconds: float = 2.0,
) -> dict[str, Any]:
    if sample_count < 3:
        raise CycleError("THREE_RECONCILIATION_SAMPLES_REQUIRED")
    samples: list[dict[str, Any]] = []
    for index in range(sample_count):
        account = _require_uat_payload(
            requester("GET", "/v1/account-snapshot"), "ACCOUNT"
        )
        recovery = _require_uat_payload(
            requester("GET", "/v1/recovery/candidates"), "RECOVERY"
        )
        positions = account.get("portfolio")
        orders = account.get("orders")
        operations = recovery.get("operations")
        if not isinstance(positions, list) or not isinstance(orders, list):
            raise CycleError("ACCOUNT_SNAPSHOT_UNVERIFIED")
        if not isinstance(operations, list):
            raise CycleError("RECOVERY_RESPONSE_UNVERIFIED")
        matches = [
            item for item in operations
            if isinstance(item, Mapping) and item.get("requestId") == request_id
        ]
        if len(matches) != 1:
            raise CycleError("RECONCILIATION_REQUEST_NOT_UNIQUE")
        item = matches[0]
        if (
            positions
            or orders
            or item.get("classification") != "NO_CANDIDATE"
            or item.get("matchCount") != 0
        ):
            raise CycleError("NO_CANDIDATE_NOT_PROVEN")
        samples.append({
            "sample": index + 1,
            "positions": 0,
            "orders": 0,
            "classification": "NO_CANDIDATE",
        })
        if index + 1 < sample_count and delay_seconds > 0:
            time.sleep(delay_seconds)
    return {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "samples": samples,
    }


def main(argv: list[str] | None = None) -> int:
    configure_utf8_output(sys.stdout)
    configure_utf8_output(sys.stderr)
    parser = argparse.ArgumentParser(description="Reconcile one Settrade UAT ambiguity")
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args(argv)

    gateway_dir = Path(__file__).resolve().parent
    env_path = Path(os.environ.get("BROKER_GATEWAY_ENV_FILE", gateway_dir / ".env"))
    values: dict[str, str] = {}
    load_env_file(str(env_path), values)
    try:
        validate_uat_guard(values, args.confirm)
        config = BrokerGatewayConfig.from_mapping(values)
        host = values.get("BROKER_GATEWAY_HOST", "127.0.0.1")
        port = int(values.get("BROKER_GATEWAY_PORT", "8787"))
        display_host = f"[{host}]" if host == "::1" else host
        requester = build_requester(
            f"http://{display_host}:{port}", values.get("BROKER_GATEWAY_TOKEN", "")
        )
        unresolved = _require_uat_payload(
            requester("GET", "/v1/journal/unresolved"), "UNRESOLVED"
        ).get("operations")
        if not isinstance(unresolved, list) or len(unresolved) != 1:
            raise CycleError("EXACTLY_ONE_UNRESOLVED_REQUIRED")
        operation = unresolved[0]
        if (
            not isinstance(operation, Mapping)
            or operation.get("requestId") != args.request_id
            or operation.get("operation") != "PLACE"
        ):
            raise CycleError("UNRESOLVED_REQUEST_MISMATCH")
        proof = collect_no_candidate_proof(requester, args.request_id)
        journal = BrokerJournal(str(_resolved_journal_path(config.journal_path)))
        try:
            journal.resolve_no_candidate(args.request_id, proof=proof)
        finally:
            journal.close()
        health = _require_uat_payload(requester("GET", "/v1/health"), "HEALTH")
        if health.get("ready") is not True or health.get("unresolvedOperations") != 0:
            raise CycleError("RECONCILIATION_NOT_CLEARED")
    except (BrokerPolicyError, CycleError, ValueError) as error:
        print(f"UAT RECONCILIATION: ไม่ผ่าน — {error}")
        return 1

    print("UAT RECONCILIATION: ผ่าน — ยืนยันซ้ำว่าไม่มีออเดอร์/สถานะถือครอง")
    print("Journal ปลดล็อกแล้ว; ยังไม่มีการส่งออเดอร์ใหม่")
    print("เงินจริงยังล็อก: REAL-NO-GO")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
