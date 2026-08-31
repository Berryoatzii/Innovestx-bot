from __future__ import annotations

import unittest
from pathlib import Path

from production_readonly_client_probe import probe_existing_gateway
from production_readonly_watchdog import ProductionWatchdogConfig


def config() -> ProductionWatchdogConfig:
    root = Path(__file__).resolve().parent
    return ProductionWatchdogConfig(
        env_path=root / ".env.production-readonly",
        gateway_dir=root,
        python_exe=root / ".venv" / "Scripts" / "python.exe",
        gateway_script=root / "gateway.py",
        host="127.0.0.1",
        port=8788,
        token="not-printed",
    )


class ProductionReadonlyClientProbeTests(unittest.TestCase):
    def test_probe_uses_get_paths_and_returns_only_sanitized_aggregate(self) -> None:
        paths: list[str] = []

        def request(_config: ProductionWatchdogConfig, path: str):
            paths.append(path)
            if path == "/v1/health":
                return {"ok": True, "environment": "prod", "data": {"ready": True}}
            if path == "/v1/account-snapshot":
                return {"ok": True, "environment": "prod", "data": {
                    "cash": 1000.0,
                    "cashVerified": True,
                    "cashField": "cashBalance",
                    "accountInfo": {"accountType": "CASH_BALANCE", "accountNo": "must-not-leak"},
                    "portfolio": [{"sym": "AAA", "qty": 100, "avg": 10, "mkt": 12}],
                    "orders": [],
                }}
            if path == "/v1/journal/unresolved":
                return {"ok": True, "environment": "prod", "data": {"operations": []}}
            symbol = path.rsplit("/", 1)[-1]
            return {"ok": True, "environment": "prod", "data": {"quote": {
                "symbol": symbol, "marketStatus": "OPEN", "last": 2.0,
                "bid": 1.9, "ask": 2.0, "bidVolume": 100, "askVolume": 200, "volume": 1000,
            }}}

        result = probe_existing_gateway(config(), ["TTB", "OR"], request)
        self.assertEqual(paths, [
            "/v1/health", "/v1/account-snapshot", "/v1/journal/unresolved",
            "/v1/market-snapshot/TTB", "/v1/market-snapshot/OR",
        ])
        self.assertEqual(result["portfolioCost"], 1000.0)
        self.assertEqual(result["portfolioMarketValue"], 1200.0)
        self.assertEqual(result["cashWeight"], round(1000 / 2200, 6))
        self.assertEqual(result["cashField"], "cashBalance")
        self.assertTrue(result["brokerReadCalled"])
        self.assertFalse(result["brokerMutationCalled"])
        self.assertFalse(result["orderEndpointCalled"])
        self.assertFalse(result["moneyMoving"])
        self.assertNotIn("accountInfo", result)
        self.assertNotIn("portfolio", result)
        self.assertNotIn("token", str(result).lower())
        self.assertNotIn("must-not-leak", str(result))

    def test_probe_rejects_duplicate_or_invalid_symbols_before_any_request(self) -> None:
        calls = []
        request = lambda *_args: calls.append(_args)  # noqa: E731
        with self.assertRaisesRegex(ValueError, "SYMBOL_LIST_DUPLICATE"):
            probe_existing_gateway(config(), ["TTB", "ttb"], request)
        with self.assertRaisesRegex(ValueError, "SYMBOL_LIST_INVALID"):
            probe_existing_gateway(config(), ["../../orders"], request)
        self.assertEqual(calls, [])

    def test_probe_fails_closed_on_quote_symbol_mismatch(self) -> None:
        def request(_config: ProductionWatchdogConfig, path: str):
            if path == "/v1/health":
                return {"ok": True, "environment": "prod", "data": {"ready": True}}
            if path == "/v1/account-snapshot":
                return {"ok": True, "environment": "prod", "data": {
                    "cash": 1, "cashVerified": True, "cashField": "cashBalance",
                    "portfolio": [], "orders": [],
                }}
            if path == "/v1/journal/unresolved":
                return {"ok": True, "environment": "prod", "data": {"operations": []}}
            return {"ok": True, "environment": "prod", "data": {"quote": {"symbol": "WRONG"}}}

        with self.assertRaisesRegex(RuntimeError, "QUOTE_SYMBOL_MISMATCH:TTB"):
            probe_existing_gateway(config(), ["TTB"], request)


if __name__ == "__main__":
    unittest.main()
