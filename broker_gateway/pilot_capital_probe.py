"""Sanitized production read-only feasibility proof for one fully-paid pilot lot."""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from gateway import load_env_file
from private_worker import WorkerError, _gateway
from uat_order_cycle import set_tick_size


FULLY_PAID_ACCOUNT_TYPES = {
    "CASH_BALANCE",
    "CASH_BALANCE_FOR_TURNOVERLIST",
}
FEE_SOURCE = "https://www.innovestx.co.th/products/stock/Thai-Stock/stock-fee"
TAX_SOURCE = "https://www.set.or.th/th/market/information/tax"


def round_money(value: float) -> float:
    return round(value + 1e-10, 2)


def side_cost(notional: float, model: Mapping[str, float]) -> float:
    commission = max(notional * model["commissionRate"], model["minimumCommissionPerDay"])
    exchange = notional * (
        model["setTradingFeeRate"]
        + model["clearingFeeRate"]
        + model["regulatoryFeeRate"]
    )
    vat = (commission + exchange) * model["vatRate"]
    slippage = notional * model["slippageBpsPerSide"] / 10000
    return commission + exchange + vat + slippage


def evaluate(values: Mapping[str, str], symbol: str, quantity: int, price: float) -> dict[str, Any]:
    if str(values.get("BROKER_ENVIRONMENT", "")).casefold() != "prod":
        raise WorkerError("PRODUCTION_ONLY")
    if str(values.get("BROKER_PRODUCTION_READ_ONLY", "")).casefold() != "true":
        raise WorkerError("PRODUCTION_READ_ONLY_REQUIRED")
    if str(values.get("BROKER_PRODUCTION_ENABLED", "")).casefold() != "false":
        raise WorkerError("PRODUCTION_MUTATIONS_FORBIDDEN")

    normalized_symbol = str(symbol).upper().strip()
    if not normalized_symbol or quantity <= 0 or price <= 0:
        raise WorkerError("PILOT_INPUT_INVALID")
    board_lot = int(values.get("BROKER_BOARD_LOT", "100") or 100)
    if quantity % board_lot:
        raise WorkerError("BOARD_LOT_REQUIRED")
    tick_size = set_tick_size(price)
    if abs(price / tick_size - round(price / tick_size)) > 1e-7:
        raise WorkerError("PRICE_NOT_TICK_ALIGNED")

    account = _gateway(values, "GET", "/v1/account-snapshot")
    account_type = str((account.get("accountInfo") or {}).get("accountType", "")).upper()
    cash = float(account.get("cash") or 0)
    positions = account.get("portfolio") if isinstance(account.get("portfolio"), list) else []
    orders = account.get("orders") if isinstance(account.get("orders"), list) else []
    total_equity = cash + sum(
        float(item.get("qty", 0) or 0) * float(item.get("mkt", 0) or 0)
        for item in positions
        if isinstance(item, Mapping)
    )
    quote_data = _gateway(values, "GET", f"/v1/market-snapshot/{normalized_symbol}")
    market = quote_data.get("quote") if isinstance(quote_data.get("quote"), Mapping) else quote_data
    bid = float(market.get("bid") or 0)
    ask = float(market.get("ask") or 0)
    last = float(market.get("last") or 0)
    if str(market.get("marketStatus", "")).casefold() not in {"open", "open1", "open2"}:
        raise WorkerError("MARKET_NOT_OPEN")
    if not all(math.isfinite(item) and item > 0 for item in (bid, ask, last)) or ask < bid:
        raise WorkerError("QUOTE_NOT_TRADEABLE")
    if price >= bid:
        raise WorkerError("PILOT_PRICE_NOT_PASSIVE")

    # INVX's public schedule: Cash Balance internet commission 0.15% for the
    # first THB 5m/day; SET/TSD/regulatory 0.005%/0.001%/0.001%; VAT 7%.
    # Use the published THB 50/day minimum on both sides until exemption is
    # evidenced. This is deliberately more conservative than assuming zero.
    model = {
        "commissionRate": 0.0015,
        "setTradingFeeRate": 0.00005,
        "clearingFeeRate": 0.00001,
        "regulatoryFeeRate": 0.00001,
        "vatRate": 0.07,
        "slippageBpsPerSide": 10,
        "minimumCommissionPerDay": 50,
    }
    notional = quantity * price
    round_trip_cost = side_cost(notional, model) * 2
    worst_case_loss = notional + round_trip_cost
    risk_per_trade_pct = 0.005
    max_position_weight = 0.05
    cash_reserve_weight = 0.20
    entry_cash_required = notional + side_cost(notional, model)
    minimum_required_capital = math.ceil(max(
        notional / max_position_weight,
        worst_case_loss / risk_per_trade_pct,
        entry_cash_required / (1 - cash_reserve_weight),
    ) / 1000) * 1000
    cash_reserve_sufficient = cash >= entry_cash_required + 5000
    account_capital_sufficient = total_equity >= minimum_required_capital
    passed = (
        account.get("cashVerified") is True
        and account_type in FULLY_PAID_ACCOUNT_TYPES
        and not orders
        and cash_reserve_sufficient
        and account_capital_sufficient
    )
    return {
        "schemaVersion": 1,
        "testedAt": datetime.now(timezone.utc).isoformat(),
        "environment": "prod",
        "readOnly": True,
        "productionEnabled": False,
        "accountType": account_type,
        "fullyPaidAccountType": account_type in FULLY_PAID_ACCOUNT_TYPES,
        "cashVerified": account.get("cashVerified") is True,
        "portfolioCount": len(positions),
        "ordersCount": len(orders),
        "symbol": normalized_symbol,
        "quantity": quantity,
        "price": price,
        "marketStatus": market.get("marketStatus"),
        "last": last,
        "bid": bid,
        "ask": ask,
        "passiveAtTest": price < bid,
        "boardLot": board_lot,
        "tickSize": tick_size,
        "protectionMode": "FULL_NOTIONAL_LONG_ONLY",
        "minimumRequiredCapital": minimum_required_capital,
        "accountCapitalSufficient": account_capital_sufficient,
        "cashReserveSufficient": cash_reserve_sufficient,
        "roundTripCostWorstCase": round_money(round_trip_cost),
        "costModel": model,
        "feesVerified": True,
        "feeAssumption": "INVX_PUBLISHED_CASH_BALANCE_RATE_PLUS_50_BAHT_DAILY_MINIMUM_EACH_SIDE",
        "feeSource": FEE_SOURCE,
        "taxSource": TAX_SOURCE,
        "passed": passed,
        "note": "Infrastructure feasibility only; not a recommendation or authorization to trade.",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", default=".env.production-readonly")
    parser.add_argument("--symbol", default="TTB")
    parser.add_argument("--quantity", type=int, default=100)
    parser.add_argument("--price", type=float, required=True)
    parser.add_argument("--evidence-out")
    args = parser.parse_args()
    values: dict[str, str] = {}
    load_env_file(args.env_file, values)
    result = evaluate(values, args.symbol, args.quantity, args.price)
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.evidence_out:
        output = Path(args.evidence_out).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
