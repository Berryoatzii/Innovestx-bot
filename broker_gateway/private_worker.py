"""Outbound-only AEGIS private execution worker.

The worker never exposes the local Broker Gateway. It claims one already
human-approved, signed RESTING_LIMIT intent from the control plane, performs
fresh local preflight checks, writes a durable remote attempt marker, and then
submits exactly once through the loopback Gateway.

Dry-run is the default. Real execution additionally requires the exact CLI
confirmation and PRIVATE_WORKER_EXECUTION_ENABLED=true.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from gateway import load_env_file


EXECUTION_CONFIRMATION = "EXECUTE_ONE_APPROVED_REAL_ORDER"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
ORDER_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class WorkerError(RuntimeError):
    pass


def _bool(values: Mapping[str, str], name: str) -> bool:
    return str(values.get(name, "")).casefold() == "true"


def _redacted_error(error: Exception) -> str:
    text = str(error or type(error).__name__).upper()
    text = re.sub(r"[^A-Z0-9:_-]+", "_", text).strip("_")
    return text[:160] or type(error).__name__.upper()


def _json_request(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str],
    body: Mapping[str, Any] | None = None,
    timeout: float = 15,
) -> Mapping[str, Any]:
    raw = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = Request(url, data=raw, method=method, headers={**headers, "Accept": "application/json"})
    if raw is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except Exception:
            payload = {}
        detail = _redacted_error(RuntimeError(payload.get("error", f"HTTP_{error.code}")))
        raised = WorkerError(detail)
        raised.execution_uncertain = bool(payload.get("executionUncertain"))
        raised.http_status = error.code
        raise raised from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raised = WorkerError(_redacted_error(error))
        raised.execution_uncertain = method.upper() not in {"GET", "HEAD"}
        raise raised from error
    if not isinstance(payload, Mapping):
        raise WorkerError("INVALID_JSON_RESPONSE")
    return payload


def _control(values: Mapping[str, str], action: str, **fields: Any) -> Mapping[str, Any]:
    base = str(values.get("PRIVATE_WORKER_CONTROL_URL", "")).rstrip("/")
    token = str(values.get("PRIVATE_WORKER_TOKEN", ""))
    worker_id = str(values.get("PRIVATE_WORKER_ID", ""))
    if urlparse(base).scheme != "https":
        raise WorkerError("CONTROL_PLANE_HTTPS_REQUIRED")
    if not token or not worker_id:
        raise WorkerError("PRIVATE_WORKER_IDENTITY_MISSING")
    return _json_request(
        "POST",
        base,
        headers={"X-Private-Worker-Token": token},
        body={"action": action, "workerId": worker_id, **fields},
    )


def _gateway(values: Mapping[str, str], method: str, path: str, **kwargs: Any) -> Mapping[str, Any]:
    base = str(values.get("BROKER_GATEWAY_URL", "")).rstrip("/")
    if not base:
        host = str(values.get("BROKER_GATEWAY_HOST", "127.0.0.1"))
        port = int(values.get("BROKER_GATEWAY_PORT", "8787"))
        base = f"http://{host}:{port}"
    token = str(values.get("BROKER_GATEWAY_TOKEN", ""))
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in LOCAL_HOSTS:
        raise WorkerError("BROKER_GATEWAY_LOOPBACK_REQUIRED")
    headers = {"Authorization": f"Bearer {token}"}
    if method.upper() == "POST":
        headers["X-Idempotency-Key"] = str(kwargs.pop("request_id", ""))
        headers["X-Production-Confirmation"] = str(values.get("BROKER_PRODUCTION_CONFIRMATION", ""))
    payload = _json_request(method, f"{base}{path}", headers=headers, **kwargs)
    if payload.get("ok") is not True or payload.get("environment") != "prod":
        raise WorkerError("BROKER_GATEWAY_PRODUCTION_RESPONSE_INVALID")
    data = payload.get("data")
    if not isinstance(data, Mapping):
        raise WorkerError("BROKER_GATEWAY_DATA_INVALID")
    return data


def _canonical(payload: Mapping[str, Any]) -> str:
    return "|".join([
        str(payload.get("intentId", "")).lower(),
        str(payload.get("claimId", "")).lower(),
        str(payload.get("symbol", "")).upper(),
        str(payload.get("side", "")).upper(),
        str(int(payload.get("quantity", 0))),
        f"{float(payload.get('price', 0)):.4f}",
        str(payload.get("orderStyle", "")).upper(),
        str(payload.get("expiresAt", "")),
        str(int(payload.get("portfolioQty", 0))),
        str(int(payload.get("boardLot", 0))),
        str(payload.get("instrumentType", "")).upper(),
        str(payload.get("exitMode", "")).upper(),
        str(payload.get("candidateId", "")),
        str(payload.get("strategyVersion", "")),
    ])


def verify_claim(values: Mapping[str, str], claim: Mapping[str, Any]) -> Mapping[str, Any]:
    payload = claim.get("payload")
    signature = str(claim.get("signature", ""))
    secret = str(values.get("ORDER_INTENT_GATE_SECRET", ""))
    if not isinstance(payload, Mapping) or not secret or not re.fullmatch(r"[a-f0-9]{64}", signature):
        raise WorkerError("SIGNED_CLAIM_INVALID")
    expected = hmac.new(secret.encode(), _canonical(payload).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise WorkerError("SIGNED_CLAIM_MISMATCH")
    if str(payload.get("orderStyle", "")).upper() != "RESTING_LIMIT":
        raise WorkerError("RESTING_LIMIT_REQUIRED")
    return payload


def validate_worker_environment(values: Mapping[str, str], *, execute: bool, confirmation: str) -> None:
    if str(values.get("BROKER_ENVIRONMENT", "")).casefold() != "prod":
        raise WorkerError("PRODUCTION_ENVIRONMENT_REQUIRED")
    if execute:
        if not _bool(values, "BROKER_PRODUCTION_ENABLED"):
            raise WorkerError("PRODUCTION_GATEWAY_NOT_ENABLED")
        if _bool(values, "BROKER_PRODUCTION_READ_ONLY"):
            raise WorkerError("PRODUCTION_GATEWAY_IS_READ_ONLY")
        if not str(values.get("BROKER_PRODUCTION_CONFIRMATION", "")):
            raise WorkerError("BROKER_PRODUCTION_CONFIRMATION_MISSING")
        if confirmation != EXECUTION_CONFIRMATION or not _bool(values, "PRIVATE_WORKER_EXECUTION_ENABLED"):
            raise WorkerError("EXPLICIT_PRIVATE_WORKER_EXECUTION_CONFIRMATION_REQUIRED")
    elif _bool(values, "BROKER_PRODUCTION_ENABLED") or not _bool(values, "BROKER_PRODUCTION_READ_ONLY"):
        raise WorkerError("DRY_RUN_REQUIRES_PRODUCTION_READ_ONLY")


def operational_release_status(repo_root: Path, values: Mapping[str, str]) -> Mapping[str, Any]:
    node = str(values.get("NODE_EXE", "node"))
    configured = str(values.get("REAL_MONEY_RELEASE_MANIFEST", "")).strip()
    if configured:
        manifest = Path(configured)
        if not manifest.is_absolute():
            manifest = repo_root / manifest
    else:
        private_manifest = repo_root / "config" / "real-money-release.local.json"
        manifest = private_manifest if private_manifest.exists() else (
            repo_root / "config" / "real-money-release.json"
        )
    resolved_manifest = manifest.resolve()
    if repo_root.resolve() not in resolved_manifest.parents:
        raise WorkerError("RELEASE_MANIFEST_OUTSIDE_REPOSITORY")
    script = (
        "const m=require(process.argv[1]);"
        "const r=require('./netlify/lib/real-money-release').evaluateOperationalPilotEvidence(m);"
        "process.stdout.write(JSON.stringify({passed:r.passed,blockers:r.blockers}));"
        "process.exit(r.passed?0:23)"
    )
    result = subprocess.run(
        [node, "-e", script, str(resolved_manifest)], cwd=repo_root,
        capture_output=True, text=True, timeout=20, check=False,
    )
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise WorkerError("OPERATIONAL_RELEASE_CHECK_INVALID") from error
    if not isinstance(payload, Mapping):
        raise WorkerError("OPERATIONAL_RELEASE_CHECK_INVALID")
    return payload


def _positive(value: Any) -> float:
    number = float(value or 0)
    return number if math.isfinite(number) and number > 0 else 0


def _candidate_dr_allowed(values: Mapping[str, str], payload: Mapping[str, Any]) -> bool:
    allowed_symbols = {
        symbol.strip().upper()
        for symbol in str(values.get("BROKER_ALLOWED_DR_SYMBOLS", "")).split(",")
        if symbol.strip()
    }
    return (
        str(payload.get("instrumentType", "")).upper() == "DR"
        and str(payload.get("candidateId", "")) == str(values.get("BROKER_ALLOWED_CANDIDATE_ID", ""))
        and str(payload.get("strategyVersion", "")) == str(values.get("BROKER_ALLOWED_STRATEGY_VERSION", ""))
        and str(payload.get("symbol", "")).upper() in allowed_symbols
        and int(payload.get("boardLot", 0)) == 1
    )


def preflight(values: Mapping[str, str], payload: Mapping[str, Any]) -> dict[str, Any]:
    health = _gateway(values, "GET", "/v1/health")
    if health.get("ready") is not True or int(health.get("unresolvedOperations", 0) or 0) != 0:
        raise WorkerError("BROKER_GATEWAY_NOT_READY")
    unresolved = _gateway(values, "GET", "/v1/journal/unresolved")
    if unresolved.get("operations"):
        raise WorkerError("UNRESOLVED_BROKER_OPERATION")
    account = _gateway(values, "GET", "/v1/account-snapshot")
    if account.get("cashVerified") is not True:
        raise WorkerError("CASH_NOT_VERIFIED")
    orders = account.get("orders") if isinstance(account.get("orders"), list) else []
    if orders:
        raise WorkerError("OPEN_ORDER_EXISTS")
    symbol = str(payload["symbol"]).upper()
    quote_data = _gateway(values, "GET", f"/v1/market-snapshot/{quote(symbol)}")
    market = quote_data.get("quote") if isinstance(quote_data.get("quote"), Mapping) else quote_data
    if str(market.get("marketStatus", "")).casefold() not in {"open", "open1", "open2"}:
        raise WorkerError("MARKET_NOT_OPEN")
    last, bid, ask = (_positive(market.get(name)) for name in ("last", "bid", "ask"))
    if not last or not bid or not ask or ask < bid:
        raise WorkerError("QUOTE_NOT_TRADEABLE")
    midpoint = (bid + ask) / 2
    if (ask - bid) / midpoint > float(values.get("MAX_SPREAD_PCT", "0.03")):
        raise WorkerError("SPREAD_TOO_WIDE")
    price = _positive(payload.get("price"))
    quantity = int(payload.get("quantity", 0))
    board_lot = int(payload.get("boardLot", 0) or 0)
    if board_lot <= 0:
        raise WorkerError("BOARD_LOT_INVALID")
    if quantity <= 0 or quantity % board_lot:
        raise WorkerError("BOARD_LOT_REQUIRED")
    if abs(price - last) / last > float(values.get("MAX_RESTING_LIMIT_DISTANCE_PCT", "0.15")):
        raise WorkerError("RESTING_LIMIT_TOO_FAR")
    value = quantity * price
    if value > float(values.get("BROKER_MAX_ORDER_VALUE", "0") or 0):
        raise WorkerError("ORDER_VALUE_LIMIT")
    side = str(payload.get("side", "")).upper()
    if str(payload.get("instrumentType", "")).upper() == "DR" and not _candidate_dr_allowed(values, payload):
        raise WorkerError("DR_CANDIDATE_SCOPE_INVALID")
    if side == "SELL":
        positions = account.get("portfolio") if isinstance(account.get("portfolio"), list) else []
        position = next((item for item in positions if str(item.get("sym", "")).upper() == symbol), None)
        held = int(float(position.get("qty", 0) or 0)) if isinstance(position, Mapping) else 0
        if held <= 0 or quantity > held:
            raise WorkerError("SELL_POSITION_INVALID")
        if str(payload.get("exitMode", "")).upper() == "FULL_POSITION":
            if not _candidate_dr_allowed(values, payload):
                raise WorkerError("FULL_EXIT_CANDIDATE_SCOPE_INVALID")
            if quantity != held or int(payload.get("portfolioQty", 0)) != held:
                raise WorkerError("FULL_EXIT_FRESH_QUANTITY_MISMATCH")
        else:
            max_fraction = float(values.get("MAX_LIVE_POSITION_FRACTION", "0.25") or 0.25)
            if quantity >= held or quantity > math.floor(held * max_fraction):
                raise WorkerError("POSITION_FRACTION_LIMIT_EXCEEDED")
    if side == "BUY":
        cash = _positive(account.get("cash"))
        reserve = float(values.get("MIN_LIVE_CASH_RESERVE", "5000") or 5000)
        if cash - value * 1.01 < reserve:
            raise WorkerError("CASH_RESERVE_WOULD_BE_BREACHED")
    return {
        "symbol": symbol,
        "side": str(payload["side"]).upper(),
        "quantity": quantity,
        "price": price,
    }


def classify_broker_order(order: Mapping[str, Any]) -> str:
    status = str(order.get("status", "")).strip().upper()
    quantity = float(order.get("quantity", order.get("vol", order.get("volume", 0))) or 0)
    matched = float(order.get("matchedQuantity", order.get("matched", order.get("matchQty", 0))) or 0)
    if matched > 0 or status in {"M", "MP", "MATCHED", "FILLED", "PARTIAL", "PARTIALLY_FILLED"}:
        return "FILLED" if (quantity > 0 and matched >= quantity) or status in {"M", "MATCHED", "FILLED"} else "PARTIALLY_FILLED"
    if status in {"C", "CX", "CANCELLED", "CANCELED"}:
        return "CANCELLED"
    if status in {"R", "REJECTED"}:
        return "REJECTED_BY_BROKER"
    if status in {"E", "EXPIRED"}:
        return "EXPIRED_BY_BROKER"
    if order.get("canCancel") is True or status in {"S", "SX", "OPEN", "PENDING", "ACCEPTED", "SUBMITTED", "WAITING"}:
        return "ACKNOWLEDGED"
    return "RECONCILE_PENDING"


def reconcile_one(values: Mapping[str, str]) -> Mapping[str, Any] | None:
    response = _control(values, "reconcile-next")
    pending = response.get("pending")
    if not isinstance(pending, Mapping):
        return None
    identity = {"intentId": pending.get("intentId"), "claimId": pending.get("claimId")}
    order_id = str(pending.get("orderId", ""))
    if not ORDER_ID_RE.fullmatch(order_id):
        # An uncertain attempt without a broker order number requires the
        # dedicated recovery-candidate workflow; never infer rejection or retry.
        return {**identity, "status": "EXECUTION_UNCERTAIN", "requiresManualRecovery": True}
    order = _gateway(values, "GET", f"/v1/orders/{quote(order_id)}").get("order", {})
    outcome = classify_broker_order(order)
    matched = int(float(order.get("matchedQuantity", order.get("matched", 0)) or 0))
    _control(
        values,
        "reconcile",
        **identity,
        outcome=outcome,
        brokerStatus=str(order.get("status", ""))[:80],
        matchedQuantity=matched,
    )
    return {**identity, "status": outcome, "matchedQuantity": matched}


def run_once(values: Mapping[str, str], repo_root: Path, *, execute: bool, confirmation: str) -> Mapping[str, Any]:
    validate_worker_environment(values, execute=execute, confirmation=confirmation)
    release = operational_release_status(repo_root, values)
    if not execute:
        health = _gateway(values, "GET", "/v1/health")
        account = _gateway(values, "GET", "/v1/account-snapshot")
        return {
            "mode": "DRY_RUN",
            "ready": health.get("ready") is True,
            "accountType": str((account.get("accountInfo") or {}).get("accountType", "")),
            "cashVerified": account.get("cashVerified") is True,
            "portfolioCount": len(account.get("portfolio") or []),
            "ordersCount": len(account.get("orders") or []),
            "releasePassed": release.get("passed") is True,
            "releaseBlockerCount": len(release.get("blockers", [])),
            "claimed": False,
        }
    if release.get("passed") is not True:
        raise WorkerError("OPERATIONAL_RELEASE_EVIDENCE_NOT_PASSED")

    reconciled = reconcile_one(values)
    if reconciled is not None:
        return {"mode": "EXECUTE", "claimed": False, "reconciled": reconciled}

    response = _control(values, "claim")
    claim = response.get("claim")
    if claim is None:
        return {"mode": "EXECUTE", "claimed": False, "status": "NO_APPROVED_INTENT"}
    payload = verify_claim(values, claim)
    identity = {"intentId": payload["intentId"], "claimId": payload["claimId"]}
    try:
        order = preflight(values, payload)
    except Exception as error:
        _control(values, "precheck-failed", **identity, reason=_redacted_error(error))
        raise

    _control(values, "mark-attempt", **identity, order=order)
    try:
        placed = _gateway(
            values, "POST", "/v1/orders", request_id=str(payload["intentId"]), body=order,
        )
    except WorkerError as error:
        outcome = "EXECUTION_UNCERTAIN" if getattr(error, "execution_uncertain", True) else "REJECTED_BY_BROKER"
        _control(values, "submission", **identity, outcome=outcome, reason=_redacted_error(error))
        raise
    order_id = str(placed.get("orderNo", ""))
    if not ORDER_ID_RE.fullmatch(order_id):
        _control(values, "submission", **identity, outcome="EXECUTION_UNCERTAIN", reason="BROKER_ORDER_ID_INVALID")
        raise WorkerError("BROKER_ORDER_ID_INVALID")
    _control(values, "submission", **identity, outcome="SUBMITTED", orderId=order_id, responseStatus=200)
    readback = _gateway(values, "GET", f"/v1/orders/{quote(order_id)}").get("order", {})
    outcome = classify_broker_order(readback)
    matched_quantity = int(float(readback.get("matchedQuantity", readback.get("matched", 0)) or 0))
    _control(
        values,
        "reconcile",
        **identity,
        outcome=outcome,
        brokerStatus=str(readback.get("status", ""))[:80],
        matchedQuantity=matched_quantity,
    )
    return {
        "mode": "EXECUTE",
        "claimed": True,
        "intentId": payload["intentId"],
        "orderId": order_id,
        "brokerStatus": str(readback.get("status", ""))[:80],
        "status": outcome,
        "matchedQuantity": matched_quantity,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="AEGIS outbound private execution worker")
    parser.add_argument("--env-file", default=".env.production-pilot")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()
    env_path = Path(args.env_file).resolve()
    values = dict(os.environ)
    load_env_file(str(env_path), values)
    repo_root = Path(__file__).resolve().parent.parent
    try:
        result = run_once(values, repo_root, execute=args.execute, confirmation=args.confirm)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": _redacted_error(error)}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
