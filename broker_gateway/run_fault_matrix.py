"""Run the deterministic Settrade fault matrix without broker mutations.

The harness combines the completed UAT lifecycle proof with fault-injection
tests.  It never reads credentials, contacts the broker, or emits account data.
Only a sanitized pass/fail manifest is written to the private evidence folder.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
UAT_EVIDENCE = ROOT / "broker_gateway" / "uat_evidence"
RELEASE_EVIDENCE = ROOT / "broker_gateway" / "release_evidence"

NODE_FILES = [
    "tests/broker-gateway-client.test.js",
    "tests/human-approval.test.js",
    "tests/operator-ready.test.js",
    "tests/reconciliation.test.js",
    "tests/private-worker-readiness.test.js",
    "tests/operational-pilot-lock.test.js",
    "tests/pilot-capital-feasibility.test.js",
    "tests/private-worker-queue.test.js",
    "tests/safety-lock.test.js",
]

CASES: dict[int, tuple[str, tuple[str, ...]]] = {
    1: ("Environment missing or inconsistent", ("test_missing_environment_fails_closed", "test_sdk_environment_is_explicitly_bound")),
    2: ("Production gate incomplete", ("test_production_requires_three_explicit_unlocks", "test_production_read_only_blocks_order_post")),
    3: ("Gateway token invalid", ("test_health_requires_bearer_and_reports_uat",)),
    4: ("Cleartext remote gateway", ("remote cleartext gateway URL fails closed",)),
    5: ("Invalid symbol, quantity or price", ("test_order_policy_is_checked_before_any_request", "test_gateway_rejects_odd_lot")),
    6: ("Unsupported order style", ("test_order_value_and_order_type_are_restricted", "worker can submit only the exact approved resting Limit order")),
    7: ("Missing idempotency key", ("test_order_requires_idempotency_and_duplicate_is_not_resubmitted",)),
    8: ("Same key and payload", ("test_same_request_id_never_places_twice",)),
    9: ("Same key with different payload", ("test_idempotency_key_cannot_be_reused_for_a_different_order",)),
    10: ("Broker response lacks order number", ("test_broker_success_without_order_number_is_uncertain_and_never_retried",)),
    11: ("Network timeout during submission", ("test_transport_failure_is_uncertain_and_never_retried",)),
    12: ("Authentication error during mutation", ("test_mutation_never_retries_after_401",)),
    13: ("Crash around broker acceptance", ("test_broker_accept_before_journal_failure_freezes_and_recovers_read_only", "test_uncertain_request_is_not_replayed_after_process_restart")),
    14: ("Concurrent session or worker", ("test_process_fence_allows_only_one_gateway", "unknown lock-write outcome fails closed")),
    15: ("Matching open order exists", ("test_open_same_symbol_and_side_order_blocks_duplicate_submission",)),
    16: ("Auction, lunch or closed market", ("Thai market session gate excludes auctions and lunch",)),
    17: ("Missing, inverted or wide quote", ("market data gate rejects stale-looking zero quotes and wide spreads",)),
    18: ("Price drift exceeds limit", ("market data gate rejects excessive price drift and resting-limit distance",)),
    19: ("Cash reserve or position cap", ("BUY proposal sizing respects cash reserve", "fails closed when one board lot exceeds the active position cap")),
    20: ("Daily order or value cap", ("daily risk gate reserves uncertain and concurrent approvals", "only the first operational pilot reservation succeeds")),
    21: ("Partial fill", ("test_partial_fill_waits_to_cancel_remainder", "intent state machine permits partial fill to complete later")),
    22: ("Order cannot be cancelled", ("test_cycle_does_not_claim_complete_when_order_cannot_be_cancelled",)),
    23: ("Cancel cannot be confirmed", ("test_cancel_pending_or_partial_cancel_is_not_terminal_confirmation",)),
    24: ("Worker loses network after approval", ("execution-uncertain response is preserved for the caller", "test_uncertain_request_is_not_replayed_after_process_restart")),
    25: ("Alert channel unavailable", ("missing alert evidence keeps the private worker locked",)),
}


def _run(command: list[str]) -> tuple[bool, str]:
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    output = f"{completed.stdout}\n{completed.stderr}"
    return completed.returncode == 0, output


def _latest_uat_proof() -> tuple[Path, dict[str, Any]]:
    candidates = sorted(UAT_EVIDENCE.glob("*-complete.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not candidates:
        raise RuntimeError("UAT_LIFECYCLE_EVIDENCE_MISSING")
    path = candidates[0]
    payload = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "environment": "uat",
        "duplicateProtected": True,
        "cancellationVerified": True,
        "complete": True,
    }
    if any(payload.get(key) != value for key, value in required.items()):
        raise RuntimeError("UAT_LIFECYCLE_EVIDENCE_INCOMPLETE")
    if int(payload.get("matchedQuantity", -1)) != 0:
        raise RuntimeError("UAT_LIFECYCLE_MATCHED_QUANTITY_NOT_ZERO")
    return path, payload


def run_matrix(output_path: Path) -> dict[str, Any]:
    uat_path, uat = _latest_uat_proof()
    python_ok, python_output = _run([
        sys.executable, "-m", "unittest", "discover", "-s", "broker_gateway", "-p", "test_*.py", "-v",
    ])
    node_ok, node_output = _run(["node", "--test", *NODE_FILES])
    combined = f"{python_output}\n{node_output}"
    cases = []
    for case_id, (name, markers) in CASES.items():
        missing = [marker for marker in markers if marker not in combined]
        cases.append({
            "id": case_id,
            "name": name,
            "passed": python_ok and node_ok and not missing,
            "coverageCount": len(markers),
        })
    complete = len(cases) == 25 and all(item["passed"] for item in cases)
    evidence = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "environment": "uat",
        "realMoney": False,
        "mutationAuthorized": False,
        "uatLifecycle": {
            "complete": True,
            "duplicateProtected": True,
            "cancellationVerified": True,
            "matchedQuantity": 0,
            "sourceSha256": hashlib.sha256(uat_path.read_bytes()).hexdigest(),
            "testedAt": str(uat.get("testedAt", "")),
        },
        "suiteHashes": {
            "python": hashlib.sha256(python_output.encode("utf-8")).hexdigest(),
            "node": hashlib.sha256(node_output.encode("utf-8")).hexdigest(),
        },
        "caseCount": len(cases),
        "passedCaseCount": sum(1 for item in cases if item["passed"]),
        "cases": cases,
        "complete": complete,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=RELEASE_EVIDENCE / f"uat-fault-matrix-{datetime.now().date().isoformat()}.json")
    args = parser.parse_args()
    evidence = run_matrix(args.output.resolve())
    print(json.dumps({
        "complete": evidence["complete"],
        "caseCount": evidence["caseCount"],
        "passedCaseCount": evidence["passedCaseCount"],
        "mutationAuthorized": False,
        "output": str(args.output),
    }, ensure_ascii=False))
    return 0 if evidence["complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
