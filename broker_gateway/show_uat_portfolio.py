"""Print a sanitized read-only UAT portfolio summary from the local gateway."""

from __future__ import annotations

import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any, Mapping

from gateway import load_env_file
from verify_uat import request_json


class PortfolioViewError(RuntimeError):
    pass


def load_portfolio_policy(path: str) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PortfolioViewError("INVALID_PORTFOLIO_POLICY") from error
    if not isinstance(payload, Mapping):
        raise PortfolioViewError("INVALID_PORTFOLIO_POLICY")
    targets = payload.get("targets")
    classification = payload.get("classification")
    if not isinstance(targets, Mapping) or not isinstance(classification, Mapping):
        raise PortfolioViewError("INVALID_PORTFOLIO_POLICY")
    target_values = {name: _number(targets.get(name, 0)) for name in ("CORE", "ACTIVE", "CASH", "REVIEW")}
    if any(value < 0 or value > 1 for value in target_values.values()) or not math.isclose(sum(target_values.values()), 1.0):
        raise PortfolioViewError("INVALID_PORTFOLIO_POLICY")
    return dict(payload)


def classify_portfolio(summary: Mapping[str, Any], policy: Mapping[str, Any]) -> dict[str, Any]:
    classification = policy.get("classification") if isinstance(policy.get("classification"), Mapping) else {}
    buckets: dict[str, set[str]] = {}
    for bucket, field in (("CORE", "coreSymbols"), ("ACTIVE", "activeSymbols"), ("REVIEW", "reviewSymbols")):
        raw = classification.get(field, [])
        if not isinstance(raw, list):
            raise PortfolioViewError("INVALID_PORTFOLIO_POLICY")
        symbols = {str(value).upper().strip() for value in raw}
        if any(not re.fullmatch(r"[A-Z0-9._-]{1,20}", value) for value in symbols):
            raise PortfolioViewError("INVALID_PORTFOLIO_POLICY")
        buckets[bucket] = symbols
    combined = [symbol for symbols in buckets.values() for symbol in symbols]
    if len(combined) != len(set(combined)):
        raise PortfolioViewError("DUPLICATE_PORTFOLIO_CLASSIFICATION")

    cash = summary.get("cash") if summary.get("cashVerified") is True else None
    market_total = _number(summary.get("totals", {}).get("marketValue", 0))
    total_equity = market_total + float(cash) if isinstance(cash, (int, float)) else None
    bucket_values = {"CORE": 0.0, "ACTIVE": 0.0, "REVIEW": 0.0, "CASH": float(cash or 0)}
    unclassified: list[str] = []
    rows: list[dict[str, Any]] = []
    for item in summary.get("positions", []):
        symbol = str(item.get("symbol", ""))
        explicit_bucket = next((bucket for bucket in ("CORE", "ACTIVE", "REVIEW") if symbol in buckets[bucket]), None)
        bucket = explicit_bucket or "REVIEW"
        if explicit_bucket is None:
            unclassified.append(symbol)
        market_value = _number(item.get("marketValue", 0))
        bucket_values[bucket] += market_value
        rows.append({
            **dict(item),
            "bucket": bucket,
            "classificationExplicit": explicit_bucket is not None,
            "portfolioWeightPct": round(market_value / total_equity * 100, 2) if total_equity and total_equity > 0 else None,
        })

    targets = policy.get("targets", {})
    bucket_summary = {}
    for bucket in ("CORE", "ACTIVE", "REVIEW", "CASH"):
        actual_pct = bucket_values[bucket] / total_equity * 100 if total_equity and total_equity > 0 else None
        target_pct = _number(targets.get(bucket, 0)) * 100
        bucket_summary[bucket] = {
            "marketValue": round(bucket_values[bucket], 2),
            "actualPct": round(actual_pct, 2) if actual_pct is not None else None,
            "targetPct": round(target_pct, 2),
            "gapPct": round(actual_pct - target_pct, 2) if actual_pct is not None else None,
        }
    return {
        **dict(summary),
        "positions": rows,
        "totalEquity": round(total_equity, 2) if total_equity is not None else None,
        "buckets": bucket_summary,
        "classificationComplete": not unclassified,
        "unclassifiedSymbols": sorted(unclassified),
    }


def _number(value: Any) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise PortfolioViewError("INVALID_PORTFOLIO_POSITION")
    return float(value)


def summarize_portfolio(payload: Mapping[str, Any]) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload.get("data"), Mapping) else {}
    if payload.get("ok") is not True or payload.get("environment") != "uat" or data.get("environment") != "uat":
        raise PortfolioViewError("UAT_ONLY")
    raw_positions = data.get("portfolio")
    if not isinstance(raw_positions, list):
        raise PortfolioViewError("INVALID_PORTFOLIO")

    positions: list[dict[str, Any]] = []
    for item in raw_positions:
        if not isinstance(item, Mapping):
            raise PortfolioViewError("INVALID_PORTFOLIO_POSITION")
        symbol = str(item.get("sym", "")).upper().strip()
        if not re.fullmatch(r"[A-Z0-9._-]{1,20}", symbol):
            raise PortfolioViewError("INVALID_PORTFOLIO_POSITION")
        qty = _number(item.get("qty", 0))
        avg = _number(item.get("avg", 0))
        market = _number(item.get("mkt", 0))
        if qty < 0 or avg < 0 or market < 0:
            raise PortfolioViewError("INVALID_PORTFOLIO_POSITION")
        cost = qty * avg
        market_value = qty * market
        pnl = market_value - cost
        pnl_pct = (pnl / cost * 100) if cost > 0 else None
        positions.append({
            "symbol": symbol,
            "quantity": qty,
            "average": avg,
            "market": market,
            "marketValue": round(market_value, 2),
            "pnl": round(pnl, 2),
            "pnlPct": round(pnl_pct, 2) if pnl_pct is not None else None,
        })

    cost_total = sum(item["quantity"] * item["average"] for item in positions)
    market_total = sum(item["marketValue"] for item in positions)
    cash = data.get("cash") if data.get("cashVerified") is True else None
    return {
        "environment": "uat",
        "cashVerified": cash is not None,
        "cash": float(cash) if isinstance(cash, (int, float)) else None,
        "positions": positions,
        "totals": {
            "cost": round(cost_total, 2),
            "marketValue": round(market_total, 2),
            "unrealizedPnl": round(market_total - cost_total, 2),
        },
    }


def load_summary(env_path: str) -> dict[str, Any]:
    values: dict[str, str] = {}
    load_env_file(env_path, values)
    if values.get("BROKER_ENVIRONMENT", "").lower() != "uat":
        raise PortfolioViewError("UAT_ONLY")
    host = values.get("BROKER_GATEWAY_HOST", "127.0.0.1").strip().lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise PortfolioViewError("LOCAL_GATEWAY_ONLY")
    token = values.get("BROKER_GATEWAY_TOKEN", "")
    if not token:
        raise PortfolioViewError("UAT_GATEWAY_TOKEN_MISSING")
    port = int(values.get("BROKER_GATEWAY_PORT", "8787"))
    display_host = f"[{host}]" if host == "::1" else host
    payload = request_json(f"http://{display_host}:{port}", token, "/v1/account-snapshot")
    return summarize_portfolio(payload)


def main() -> int:
    env_path = os.environ.get("BROKER_GATEWAY_ENV_FILE", os.path.join(os.path.dirname(__file__), ".env"))
    try:
        summary = load_summary(env_path)
    except Exception as error:
        print(f"UAT PORTFOLIO NOT READY: {error}", file=sys.stderr)
        return 1
    print("\nUAT PORTFOLIO (READ-ONLY — NO ORDER SENT)")
    if not summary["positions"]:
        print("No positions")
    for item in summary["positions"]:
        pct = "N/A" if item["pnlPct"] is None else f"{item['pnlPct']:+.2f}%"
        print(
            f"{item['symbol']:<12} qty={item['quantity']:>8g} avg={item['average']:>9.2f} "
            f"market={item['market']:>9.2f} P/L={item['pnl']:>10.2f} ({pct})"
        )
    totals = summary["totals"]
    print(f"Market value: {totals['marketValue']:.2f}")
    print(f"Unrealized P/L: {totals['unrealizedPnl']:.2f}")
    print(f"Cash: {summary['cash'] if summary['cashVerified'] else 'UNVERIFIED'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
