import json
import tempfile
import unittest
from pathlib import Path

from show_uat_portfolio import (
    PortfolioViewError,
    classify_portfolio,
    load_portfolio_policy,
    summarize_portfolio,
)


class ShowUatPortfolioTests(unittest.TestCase):
    def test_summary_calculates_positions_and_never_copies_account_data(self):
        result = summarize_portfolio({
            "ok": True,
            "environment": "uat",
            "data": {
                "environment": "uat",
                "cash": 1000,
                "cashVerified": True,
                "accountNo": "SECRET-ACCOUNT",
                "portfolio": [
                    {"sym": "AOT", "qty": 100, "avg": 18, "mkt": 20},
                    {"sym": "KTB", "qty": 200, "avg": 22, "mkt": 21},
                ],
            },
        })
        self.assertEqual(result["positions"][0]["symbol"], "AOT")
        self.assertEqual(result["positions"][0]["pnl"], 200)
        self.assertAlmostEqual(result["positions"][0]["pnlPct"], 11.11, places=2)
        self.assertEqual(result["totals"]["marketValue"], 6200)
        self.assertEqual(result["totals"]["unrealizedPnl"], 0)
        self.assertNotIn("accountNo", str(result))
        self.assertNotIn("SECRET-ACCOUNT", str(result))

    def test_summary_rejects_non_uat_or_malformed_positions(self):
        with self.assertRaisesRegex(PortfolioViewError, "UAT_ONLY"):
            summarize_portfolio({"ok": True, "environment": "prod", "data": {}})
        with self.assertRaisesRegex(PortfolioViewError, "INVALID_PORTFOLIO_POSITION"):
            summarize_portfolio({
                "ok": True,
                "environment": "uat",
                "data": {"environment": "uat", "portfolio": [{"sym": "../AOT", "qty": 100}]},
            })

    def test_classification_is_fail_closed_and_calculates_weights(self):
        summary = summarize_portfolio({
            "ok": True,
            "environment": "uat",
            "data": {
                "environment": "uat",
                "cash": 4000,
                "cashVerified": True,
                "portfolio": [
                    {"sym": "AOT", "qty": 100, "avg": 18, "mkt": 20},
                    {"sym": "KTB", "qty": 100, "avg": 20, "mkt": 20},
                ],
            },
        })
        policy = {
            "targets": {"CORE": 0.6, "ACTIVE": 0.2, "CASH": 0.2, "REVIEW": 0},
            "classification": {
                "coreSymbols": ["AOT"],
                "activeSymbols": [],
                "reviewSymbols": [],
            },
        }
        result = classify_portfolio(summary, policy)
        self.assertEqual(result["totalEquity"], 8000)
        self.assertEqual(result["positions"][0]["bucket"], "CORE")
        self.assertEqual(result["positions"][0]["portfolioWeightPct"], 25)
        self.assertEqual(result["positions"][1]["bucket"], "REVIEW")
        self.assertFalse(result["positions"][1]["classificationExplicit"])
        self.assertEqual(result["unclassifiedSymbols"], ["KTB"])
        self.assertFalse(result["classificationComplete"])
        self.assertEqual(result["buckets"]["CASH"]["actualPct"], 50)

    def test_policy_loader_rejects_invalid_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            path.write_text(json.dumps({
                "targets": {"CORE": 0.8, "ACTIVE": 0.3, "CASH": 0.2, "REVIEW": 0},
                "classification": {},
            }), encoding="utf-8")
            with self.assertRaisesRegex(PortfolioViewError, "INVALID_PORTFOLIO_POLICY"):
                load_portfolio_policy(str(path))

    def test_policy_rejects_duplicate_symbol_buckets(self):
        summary = {
            "cashVerified": True,
            "cash": 0,
            "positions": [],
            "totals": {"marketValue": 0},
        }
        policy = {
            "targets": {"CORE": 0.6, "ACTIVE": 0.2, "CASH": 0.2, "REVIEW": 0},
            "classification": {
                "coreSymbols": ["AOT"],
                "activeSymbols": ["AOT"],
                "reviewSymbols": [],
            },
        }
        with self.assertRaisesRegex(PortfolioViewError, "DUPLICATE_PORTFOLIO_CLASSIFICATION"):
            classify_portfolio(summary, policy)


if __name__ == "__main__":
    unittest.main()
