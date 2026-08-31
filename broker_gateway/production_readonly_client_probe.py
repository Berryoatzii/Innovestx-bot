"""Sanitized GET-only probe for an already-running production gateway.

Unlike the one-shot SDK probe, this client never creates a broker session and
therefore cannot collide with the gateway's single-session fence. It does not
send POST, PUT, PATCH or DELETE and never prints credentials or account IDs.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from gateway import BrokerService
from production_readonly_watchdog import (
    ProductionWatchdogConfig,
    _request_json,
    load_production_watchdog_config,
)


SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,19}$")


def _data(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    value = payload.get("data")
    return value if isinstance(value, Mapping) else {}


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0


def probe_existing_gateway(
    config: ProductionWatchdogConfig,
    symbols: list[str],
    request_json: Callable[[ProductionWatchdogConfig, str], Mapping[str, Any]] = _request_json,
) -> dict[str, Any]:
    normalized = [str(symbol).upper().strip() for symbol in symbols]
    if not normalized or len(normalized) > 20 or any(not SYMBOL_RE.fullmatch(symbol) for symbol in normalized):
        raise ValueError("SYMBOL_LIST_INVALID")
    if len(set(normalized)) != len(normalized):
        raise ValueError("SYMBOL_LIST_DUPLICATE")

    health_payload = request_json(config, "/v1/health")
    snapshot_payload = request_json(config, "/v1/account-snapshot")
    unresolved_payload = request_json(config, "/v1/journal/unresolved")
    if health_payload.get("ok") is not True or health_payload.get("environment") != "prod":
        raise RuntimeError("HEALTH_INVALID")
    if snapshot_payload.get("ok") is not True or snapshot_payload.get("environment") != "prod":
        raise RuntimeError("SNAPSHOT_INVALID")

    health = _data(health_payload)
    snapshot = _data(snapshot_payload)
    unresolved = _data(unresolved_payload).get("operations")
    unresolved = unresolved if isinstance(unresolved, list) else []
    portfolio = snapshot.get("portfolio") if isinstance(snapshot.get("portfolio"), list) else []
    orders = snapshot.get("orders") if isinstance(snapshot.get("orders"), list) else []
    open_orders = [item for item in orders if isinstance(item, Mapping) and not BrokerService._is_terminal_order(item)]
    if health.get("ready") is not True or snapshot.get("cashVerified") is not True:
        raise RuntimeError("PRODUCTION_READONLY_NOT_READY")
    if snapshot.get("cashField") != "cashBalance":
        raise RuntimeError("PRODUCTION_CASH_FIELD_UNVERIFIED")

    portfolio_cost = sum(_number(item.get("qty")) * _number(item.get("avg")) for item in portfolio if isinstance(item, Mapping))
    portfolio_market_value = sum(
        _number(item.get("qty")) * _number(item.get("mkt")) for item in portfolio if isinstance(item, Mapping)
    )
    quotes = []
    for symbol in normalized:
        quote_payload = request_json(config, f"/v1/market-snapshot/{symbol}")
        quote = _data(quote_payload).get("quote")
        if quote_payload.get("ok") is not True or quote_payload.get("environment") != "prod" or not isinstance(quote, Mapping):
            raise RuntimeError(f"QUOTE_INVALID:{symbol}")
        if str(quote.get("symbol", "")).upper() != symbol:
            raise RuntimeError(f"QUOTE_SYMBOL_MISMATCH:{symbol}")
        quotes.append({
            "symbol": symbol,
            "marketStatus": str(quote.get("marketStatus", ""))[:40],
            "last": quote.get("last"),
            "bid": quote.get("bid"),
            "ask": quote.get("ask"),
            "bidVolume": quote.get("bidVolume"),
            "askVolume": quote.get("askVolume"),
            "volume": quote.get("volume"),
        })

    cash = _number(snapshot.get("cash"))
    total_assets = cash + portfolio_market_value
    return {
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "environment": "prod",
        "ready": True,
        "readOnly": True,
        "productionEnabled": False,
        "gatewayHost": "loopback",
        "cashVerified": True,
        "cashField": "cashBalance",
        "cash": round(cash, 2),
        "portfolioCount": len(portfolio),
        "portfolioCost": round(portfolio_cost, 2),
        "portfolioMarketValue": round(portfolio_market_value, 2),
        "unrealized": round(portfolio_market_value - portfolio_cost, 2),
        "cashWeight": round(cash / total_assets, 6) if total_assets > 0 else None,
        "ordersCount": len(orders),
        "openOrders": len(open_orders),
        "unresolvedCount": len(unresolved),
        "quotes": quotes,
        "brokerReadCalled": True,
        "brokerMutationCalled": False,
        "orderEndpointCalled": False,
        "moneyMoving": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("env_path")
    parser.add_argument("--symbols", default="TTB,OR,KTB")
    args = parser.parse_args()
    config = load_production_watchdog_config(args.env_path)
    result = probe_existing_gateway(config, args.symbols.split(","))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
