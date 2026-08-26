"""Fault-inject a post-attempt network outage through private_worker.run_once.

No network or broker is contacted. The drill exercises the production worker
state machine with adapters that record the durable attempt marker, raise an
execution-uncertain transport error exactly once, and prove the next run enters
reconcile-only mode without another POST.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import private_worker as worker


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "broker_gateway" / "release_evidence" / "private-worker-outage-drill-2026-08-26.json"


def run_drill(output_path: Path) -> dict[str, Any]:
    original = {
        name: getattr(worker, name)
        for name in ("validate_worker_environment", "operational_release_status", "_control", "_gateway", "verify_claim", "preflight")
    }
    events: list[dict[str, Any]] = []
    state = {"uncertain": False, "posts": 0}
    intent_id = "d333333333333333"
    claim_id = "d" * 32
    payload = {
        "intentId": intent_id,
        "claimId": claim_id,
        "symbol": "DRILL",
        "side": "BUY",
        "quantity": 1,
        "price": 1.0,
        "orderStyle": "RESTING_LIMIT",
        "expiresAt": "2099-01-01T00:00:00Z",
    }

    def fake_control(_values: Mapping[str, str], action: str, **fields: Any) -> Mapping[str, Any]:
        events.append({"action": action, "outcome": fields.get("outcome")})
        if action == "reconcile-next":
            return {"pending": {"intentId": intent_id, "claimId": claim_id}} if state["uncertain"] else {"pending": None}
        if action == "claim":
            return {"claim": {"payload": payload, "signature": "0" * 64}}
        if action == "submission" and fields.get("outcome") == "EXECUTION_UNCERTAIN":
            state["uncertain"] = True
        return {"ok": True}

    def fake_gateway(_values: Mapping[str, str], method: str, _path: str, **_kwargs: Any) -> Mapping[str, Any]:
        if method.upper() == "POST":
            state["posts"] += 1
            error = worker.WorkerError("SIMULATED_NETWORK_TIMEOUT_AFTER_ATTEMPT")
            error.execution_uncertain = True
            raise error
        raise AssertionError("drill must not perform a broker read through this adapter")

    try:
        worker.validate_worker_environment = lambda *_args, **_kwargs: None
        worker.operational_release_status = lambda *_args, **_kwargs: {"passed": True, "blockers": []}
        worker._control = fake_control
        worker._gateway = fake_gateway
        worker.verify_claim = lambda _values, claim: claim["payload"]
        worker.preflight = lambda _values, _payload: {
            "symbol": "DRILL", "side": "BUY", "quantity": 1, "price": 1.0,
        }
        first_uncertain = False
        try:
            worker.run_once({}, ROOT, execute=True, confirmation=worker.EXECUTION_CONFIRMATION)
        except worker.WorkerError as error:
            first_uncertain = getattr(error, "execution_uncertain", False) is True
        second = worker.run_once({}, ROOT, execute=True, confirmation=worker.EXECUTION_CONFIRMATION)
    finally:
        for name, value in original.items():
            setattr(worker, name, value)

    actions = [item["action"] for item in events]
    passed = all([
        first_uncertain,
        state["posts"] == 1,
        "mark-attempt" in actions,
        any(item == {"action": "submission", "outcome": "EXECUTION_UNCERTAIN"} for item in events),
        second.get("claimed") is False,
        (second.get("reconciled") or {}).get("status") == "EXECUTION_UNCERTAIN",
        (second.get("reconciled") or {}).get("requiresManualRecovery") is True,
    ])
    evidence = {
        "schemaVersion": 1,
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "passed": passed,
        "fault": "SIMULATED_NETWORK_TIMEOUT_AFTER_DURABLE_ATTEMPT",
        "durableAttemptMarkerVerified": "mark-attempt" in actions,
        "executionUncertainPersisted": state["uncertain"] is True,
        "brokerPostAttempts": state["posts"],
        "automaticRetryAttempts": max(0, state["posts"] - 1),
        "secondRunReconcileOnly": second.get("claimed") is False,
        "manualRecoveryRequired": (second.get("reconciled") or {}).get("requiresManualRecovery") is True,
        "realMoney": False,
        "networkContacted": False,
        "brokerContacted": False,
        "mutationAuthorized": False,
        "eventSequenceSha256": hashlib.sha256(json.dumps(events, sort_keys=True).encode()).hexdigest(),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    evidence = run_drill(args.output.resolve())
    print(json.dumps({
        "passed": evidence["passed"],
        "brokerPostAttempts": evidence["brokerPostAttempts"],
        "automaticRetryAttempts": evidence["automaticRetryAttempts"],
        "networkContacted": False,
        "brokerContacted": False,
        "output": str(args.output),
    }))
    return 0 if evidence["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
