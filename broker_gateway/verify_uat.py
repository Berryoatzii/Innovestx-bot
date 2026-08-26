"""Read-only verifier for the local Settrade UAT gateway.

This script never calls a mutation endpoint and never prints credentials or the
broker account number. It is intentionally limited to a local gateway.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Callable, Mapping
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from gateway import BrokerService, load_env_file


class VerificationError(RuntimeError):
    pass


def cash_field_candidates(schema_payload: Mapping[str, Any]) -> list[str]:
    if schema_payload.get("environment") != "uat" or schema_payload.get("ok") is not True:
        raise VerificationError("UAT_SCHEMA_INVALID")
    data = _as_mapping(schema_payload.get("data"))
    if data.get("environment") != "uat" or not isinstance(data.get("fields"), list):
        raise VerificationError("UAT_SCHEMA_INVALID")
    candidates: list[str] = []
    for item in data["fields"]:
        field = _as_mapping(item)
        path = str(field.get("path", ""))
        normalized = re.sub(r"[^a-z0-9]", "", path.casefold())
        looks_like_cash = any(term in normalized for term in (
            "cash", "buyingpower", "lineavailable", "availableline", "creditline"
        ))
        if field.get("type") == "number" and looks_like_cash and path:
            candidates.append(path)
    return sorted(set(candidates))


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def summarize_recovery(payload: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("ok") is not True or payload.get("environment") != "uat":
        raise VerificationError("UAT_RECOVERY_INVALID")
    data = _as_mapping(payload.get("data"))
    operations = data.get("operations")
    if data.get("environment") != "uat" or not isinstance(operations, list):
        raise VerificationError("UAT_RECOVERY_INVALID")
    safe: list[dict[str, Any]] = []
    for raw in operations:
        item = _as_mapping(raw)
        safe.append({
            "requestId": str(item.get("requestId", ""))[:128],
            "operation": str(item.get("operation", ""))[:24],
            "status": str(item.get("status", ""))[:40],
            "orderNo": str(item.get("orderNo"))[:128] if item.get("orderNo") is not None else None,
            "createdAt": str(item.get("createdAt", ""))[:64],
            "updatedAt": str(item.get("updatedAt", ""))[:64],
        })
    return {
        "count": len(safe),
        "requiresReconciliation": bool(safe),
        "operations": safe,
    }


def summarize_recovery_candidates(payload: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("ok") is not True or payload.get("environment") != "uat":
        raise VerificationError("UAT_RECOVERY_CANDIDATES_INVALID")
    data = _as_mapping(payload.get("data"))
    operations = data.get("operations")
    if data.get("environment") != "uat" or not isinstance(operations, list):
        raise VerificationError("UAT_RECOVERY_CANDIDATES_INVALID")
    classifications = [str(_as_mapping(item).get("classification", "")) for item in operations]
    return {
        "operations": len(classifications),
        "noCandidate": classifications.count("NO_CANDIDATE"),
        "exactlyOne": classifications.count("EXACTLY_ONE_CANDIDATE"),
        "ambiguous": classifications.count("AMBIGUOUS"),
        "requiresManualReconciliation": bool(classifications),
        "automaticallyResolved": False,
    }


def summarize_uat(health_payload: Mapping[str, Any], snapshot_payload: Mapping[str, Any]) -> dict[str, Any]:
    if health_payload.get("environment") != "uat" or snapshot_payload.get("environment") != "uat":
        raise VerificationError("UAT_ENVIRONMENT_MISMATCH")
    health = _as_mapping(health_payload.get("data"))
    if health_payload.get("ok") is not True or health.get("ready") is not True:
        raise VerificationError("UAT_GATEWAY_NOT_READY")
    snapshot = _as_mapping(snapshot_payload.get("data"))
    if snapshot_payload.get("ok") is not True or snapshot.get("environment") != "uat":
        raise VerificationError("UAT_SNAPSHOT_INVALID")

    account_info = _as_mapping(snapshot.get("accountInfo"))
    portfolio = snapshot.get("portfolio") if isinstance(snapshot.get("portfolio"), list) else []
    orders = snapshot.get("orders") if isinstance(snapshot.get("orders"), list) else []
    open_orders = [item for item in orders if not BrokerService._is_terminal_order(_as_mapping(item))]
    cash = snapshot.get("cash")
    return {
        "environment": "uat",
        "gatewayReady": True,
        "accountType": str(account_info.get("accountType", "UNKNOWN")),
        "cashVerified": snapshot.get("cashVerified") is True,
        "cash": cash if isinstance(cash, (int, float)) else None,
        "positions": len(portfolio),
        "orders": len(open_orders),
        "ordersTotal": len(orders),
    }


def request_json(base_url: str, token: str, path: str, *, opener: Callable[..., Any] = urlopen) -> Mapping[str, Any]:
    request = Request(
        f"{base_url}{path}",
        method="GET",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with opener(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        safe_error = "UNKNOWN"
        try:
            failure = json.loads(error.read().decode("utf-8"))
            candidate = failure.get("error") if isinstance(failure, Mapping) else None
            if isinstance(candidate, str) and candidate.replace("_", "").isalnum() and len(candidate) <= 80:
                safe_error = candidate
        except Exception:
            pass
        raise VerificationError(f"UAT_HTTP_{error.code}:{safe_error}") from error
    except Exception as error:
        raise VerificationError(f"UAT_READ_FAILED:{type(error).__name__}") from error
    if not isinstance(payload, Mapping):
        raise VerificationError("UAT_INVALID_JSON")
    return payload


def verify_local_uat(env_path: str) -> dict[str, Any]:
    values: dict[str, str] = {}
    load_env_file(env_path, values)
    if values.get("BROKER_ENVIRONMENT", "").lower() != "uat":
        raise VerificationError("UAT_ONLY")
    host = values.get("BROKER_GATEWAY_HOST", "127.0.0.1").strip().lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise VerificationError("LOCAL_GATEWAY_ONLY")
    token = values.get("BROKER_GATEWAY_TOKEN", "")
    if not token:
        raise VerificationError("UAT_GATEWAY_TOKEN_MISSING")
    port = int(values.get("BROKER_GATEWAY_PORT", "8787"))
    display_host = f"[{host}]" if host == "::1" else host
    base_url = f"http://{display_host}:{port}"
    health = request_json(base_url, token, "/v1/health")
    snapshot = request_json(base_url, token, "/v1/account-snapshot")
    schema = request_json(base_url, token, "/v1/account-schema")
    recovery = request_json(base_url, token, "/v1/journal/unresolved")
    recovery_candidates = request_json(base_url, token, "/v1/recovery/candidates")
    summary = summarize_uat(health, snapshot)
    summary["cashFieldCandidates"] = cash_field_candidates(schema)
    summary["recovery"] = summarize_recovery(recovery)
    summary["recoveryCandidates"] = summarize_recovery_candidates(recovery_candidates)
    return summary


def main() -> int:
    env_path = os.environ.get("BROKER_GATEWAY_ENV_FILE", os.path.join(os.path.dirname(__file__), ".env"))
    try:
        summary = verify_local_uat(env_path)
    except VerificationError as error:
        print(f"UAT NOT READY: {error}", file=sys.stderr)
        return 1
    print("UAT READ-ONLY CHECK: PASS")
    print(f"Environment: {summary['environment']}")
    print(f"Gateway: {'READY' if summary['gatewayReady'] else 'NOT READY'}")
    print(f"Account type: {summary['accountType']}")
    print(f"Cash verified: {summary['cashVerified']}")
    print(f"Cash: {summary['cash'] if summary['cash'] is not None else 'UNKNOWN'}")
    if not summary["cashVerified"]:
        candidates = summary.get("cashFieldCandidates", [])
        print(f"Candidate cash fields (names only): {', '.join(candidates) if candidates else 'NONE'}")
    print(f"Positions: {summary['positions']}")
    print(f"Orders: {summary['orders']}")
    recovery = summary["recovery"]
    print(f"Unresolved operations: {recovery['count']}")
    if recovery["requiresReconciliation"]:
        print("WARNING: unresolved operation exists. Do not place another order until reconciled.")
        candidates = summary["recoveryCandidates"]
        print(
            "Recovery candidates: "
            f"one={candidates['exactlyOne']} none={candidates['noCandidate']} ambiguous={candidates['ambiguous']}"
        )
        print("Manual reconciliation is required; no journal state was changed automatically.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
