"""One-shot, sanitized production read-only account and market probe."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from gateway import GatewayHandler, build_server, load_env_file


def sanitized_evidence(result: dict[str, object]) -> dict[str, object]:
    """Remove position-level data while preserving release-gate facts."""
    return {key: value for key, value in result.items() if key != "portfolio"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("env_path", nargs="?", default=".env.production-readonly")
    parser.add_argument("--evidence-out")
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()
    env_path = Path(args.env_path)
    values: dict[str, str] = {}
    load_env_file(env_path, values)
    if not (
        values.get("BROKER_ENVIRONMENT") == "prod"
        and values.get("BROKER_PRODUCTION_READ_ONLY", "").lower() == "true"
        and values.get("BROKER_PRODUCTION_ENABLED", "").lower() == "false"
        and values.get("BROKER_GATEWAY_HOST") == "127.0.0.1"
        and values.get("BROKER_CASH_FIELD") == "cashBalance"
        and not values.get("BROKER_PRODUCTION_ACK")
        and not values.get("BROKER_PRODUCTION_CONFIRMATION")
    ):
        raise RuntimeError("PRODUCTION_READ_ONLY_GUARD_FAILED")

    server = build_server(values)
    try:
        service = GatewayHandler.service
        account = service.account_snapshot()
        orders = service.list_orders()
        unresolved = server.journal.list_unresolved()
        quotes = []
        for symbol in ("TTB", "OR", "KTB"):
            quote = service.market_snapshot(symbol)
            quotes.append(
                {
                    "symbol": symbol,
                    "marketStatus": quote.get("marketStatus"),
                    "last": quote.get("last"),
                    "bid": quote.get("bid"),
                    "ask": quote.get("ask"),
                    "volume": quote.get("volume"),
                }
            )
        result = {
            "testedAt": datetime.now(timezone.utc).isoformat(),
            "environment": account.get("environment"),
            "readOnly": True,
            "productionEnabled": False,
            "gatewayHost": "loopback",
            "cashVerified": account.get("cashVerified") is True,
            "cashField": account.get("cashField"),
            "accountType": str((account.get("accountInfo") or {}).get("accountType", "")),
            "portfolioCount": len(account.get("portfolio") or []),
            "portfolio": account.get("portfolio") or [],
            "ordersCount": len(orders),
            "unresolvedCount": len(unresolved),
            "quotes": quotes,
        }
        printed = sanitized_evidence(result) if args.summary_only else result
        print(json.dumps(printed, separators=(",", ":")))
        if args.evidence_out:
            evidence_path = Path(args.evidence_out).resolve()
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(
                json.dumps(sanitized_evidence(result), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        return 0
    finally:
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
