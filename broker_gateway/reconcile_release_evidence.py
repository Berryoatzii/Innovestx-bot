"""Promote verified, sanitized broker evidence into the release manifest.

This tool can only mark the UAT lifecycle, production read-only, and zero-unresolved
checks. It cannot unlock production, approve a strategy, or satisfy any other gate.
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
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    result = reconcile(
        load_json(manifest_path),
        Path(args.uat_evidence).resolve(),
        Path(args.production_evidence).resolve(),
        manifest_path.parent.parent,
    )
    if args.write:
        atomic_write(manifest_path, result)
    print(json.dumps({
        "verified": True,
        "written": args.write,
        "uatOrderCycleComplete": result["uatOrderCycleComplete"],
        "productionReadOnlyVerified": result["productionReadOnlyVerified"],
        "zeroUnresolvedVerified": result["zeroUnresolvedVerified"],
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
