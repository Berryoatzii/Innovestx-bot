"""Promote verified, sanitized broker evidence into the release manifest.

This tool can only mark the UAT lifecycle, production read-only, zero-unresolved,
account-level Open API activation, and frozen execution-compatibility checks. It
cannot unlock production, approve a strategy, or satisfy any other gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON_OBJECT_REQUIRED:{path.name}")
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_uat(value: dict) -> None:
    required = {
        "environment": "uat",
        "complete": True,
        "duplicateProtected": True,
        "cancellationVerified": True,
        "matchedQuantity": 0,
        "readbackClassification": "TERMINAL_CANCELLED_NO_FILL",
        "realMoney": "REAL-NO-GO",
    }
    for key, expected in required.items():
        if value.get(key) != expected:
            raise ValueError(f"UAT_EVIDENCE_FAILED:{key}")


def validate_production_readonly(value: dict) -> None:
    required = {
        "environment": "prod",
        "readOnly": True,
        "productionEnabled": False,
        "gatewayHost": "loopback",
        "cashVerified": True,
        "cashField": "cashBalance",
        "ordersCount": 0,
        "unresolvedCount": 0,
    }
    for key, expected in required.items():
        if value.get(key) != expected:
            raise ValueError(f"PRODUCTION_READONLY_EVIDENCE_FAILED:{key}")
    if "portfolio" in value:
        raise ValueError("PRODUCTION_EVIDENCE_NOT_SANITIZED")
    tested_at = datetime.fromisoformat(str(value.get("testedAt", "")).replace("Z", "+00:00"))
    age_seconds = (datetime.now(timezone.utc) - tested_at.astimezone(timezone.utc)).total_seconds()
    if age_seconds < -300 or age_seconds > 86400:
        raise ValueError("PRODUCTION_READONLY_EVIDENCE_STALE")


def validate_broker_permission(value: dict) -> None:
    required = {
        "evidenceType": "BROKER_OPEN_API_ACCOUNT_ACTIVATION",
        "broker": "InnovestX Securities",
        "sourceSender": "no-reply@innovestx.co.th",
        "sourceSubject": "Your account has been activated for Settrade Open API",
        "accountLevelOpenApiActivated": True,
        "apiKeyProvisioningOffered": True,
        "strategyLogicParametersApproved": False,
        "accountIdentifiersRedacted": True,
        "secretMaterialPresent": False,
    }
    for key, expected in required.items():
        if value.get(key) != expected:
            raise ValueError(f"BROKER_PERMISSION_EVIDENCE_FAILED:{key}")
    received_at = datetime.fromisoformat(str(value.get("sourceReceivedAt", "")).replace("Z", "+00:00"))
    verified_at = datetime.fromisoformat(str(value.get("verifiedAt", "")).replace("Z", "+00:00"))
    if received_at > verified_at:
        raise ValueError("BROKER_PERMISSION_EVIDENCE_TIME_INVALID")


def validate_execution_compatibility(value: dict, candidate_path: Path) -> None:
    candidate = load_json(candidate_path)
    required = {
        "evidenceType": "DR_EXECUTION_COMPATIBILITY",
        "passed": True,
        "candidateId": candidate.get("candidateId"),
        "strategyVersion": candidate.get("strategyVersion"),
        "candidateSha256": sha256(candidate_path),
        "restingLimitOnlyVerified": True,
        "perOrderBoardLotVerified": True,
        "freshFullExitQuantityVerified": True,
        "privateWorkerPayloadBound": True,
        "candidateDrScopeVerified": True,
        "productionLockedDuringVerification": True,
        "brokerCalled": False,
        "moneyMoving": False,
    }
    for key, expected in required.items():
        if value.get(key) != expected:
            raise ValueError(f"EXECUTION_COMPATIBILITY_EVIDENCE_FAILED:{key}")


def evidence_reference(path: Path, reference_root: Path | None) -> str:
    if reference_root is not None:
        try:
            return path.relative_to(reference_root).as_posix()
        except ValueError:
            pass
    return path.as_posix()


def reconcile(
    manifest: dict,
    uat_path: Path,
    production_path: Path,
    reference_root: Path | None = None,
    broker_permission_path: Path | None = None,
    execution_compatibility_path: Path | None = None,
) -> dict:
    validate_uat(load_json(uat_path))
    validate_production_readonly(load_json(production_path))
    result = dict(manifest)
    result["uatOrderCycleComplete"] = True
    result["productionReadOnlyVerified"] = True
    result["zeroUnresolvedVerified"] = True
    result["evidenceUpdatedAt"] = datetime.now(timezone.utc).isoformat()
    result["evidenceRefs"] = {
        **dict(result.get("evidenceRefs") or {}),
        "uatOrderCycleComplete": {
            "path": evidence_reference(uat_path, reference_root),
            "sha256": sha256(uat_path),
        },
        "productionReadOnlyVerified": {
            "path": evidence_reference(production_path, reference_root),
            "sha256": sha256(production_path),
        },
        "zeroUnresolvedVerified": {
            "path": evidence_reference(production_path, reference_root),
            "sha256": sha256(production_path),
        },
    }
    if broker_permission_path is not None:
        validate_broker_permission(load_json(broker_permission_path))
        result["brokerPermissionConfirmed"] = True
        result["evidenceRefs"]["brokerPermissionConfirmed"] = {
            "path": evidence_reference(broker_permission_path, reference_root),
            "sha256": sha256(broker_permission_path),
        }
    if execution_compatibility_path is not None:
        if reference_root is None:
            raise ValueError("REFERENCE_ROOT_REQUIRED_FOR_EXECUTION_COMPATIBILITY")
        candidate_path = reference_root / "config" / "strategy-approval-candidate.json"
        validate_execution_compatibility(load_json(execution_compatibility_path), candidate_path)
        result["executionCompatibilityVerified"] = True
        result["evidenceRefs"]["executionCompatibilityVerified"] = {
            "path": evidence_reference(execution_compatibility_path, reference_root),
            "sha256": sha256(execution_compatibility_path),
        }
    return result


def atomic_write(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--uat-evidence", required=True)
    parser.add_argument("--production-evidence", required=True)
    parser.add_argument("--broker-permission-evidence")
    parser.add_argument("--execution-compatibility-evidence")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    result = reconcile(
        load_json(manifest_path),
        Path(args.uat_evidence).resolve(),
        Path(args.production_evidence).resolve(),
        manifest_path.parent.parent,
        Path(args.broker_permission_evidence).resolve() if args.broker_permission_evidence else None,
        Path(args.execution_compatibility_evidence).resolve() if args.execution_compatibility_evidence else None,
    )
    if args.write:
        atomic_write(manifest_path, result)
    print(json.dumps({
        "verified": True,
        "written": args.write,
        "uatOrderCycleComplete": result["uatOrderCycleComplete"],
        "productionReadOnlyVerified": result["productionReadOnlyVerified"],
        "zeroUnresolvedVerified": result["zeroUnresolvedVerified"],
        "brokerPermissionConfirmed": result.get("brokerPermissionConfirmed", False),
        "executionCompatibilityVerified": result.get("executionCompatibilityVerified", False),
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
