import unittest
from unittest.mock import patch

from pilot_capital_probe import evaluate, side_cost
from private_worker import WorkerError


class PilotCapitalProbeTests(unittest.TestCase):
    def values(self):
        return {
            "BROKER_ENVIRONMENT": "prod",
            "BROKER_PRODUCTION_READ_ONLY": "true",
            "BROKER_PRODUCTION_ENABLED": "false",
            "BROKER_BOARD_LOT": "100",
        }

    def test_minimum_commission_is_applied_before_vat(self):
        model = {
            "commissionRate": 0.0015, "setTradingFeeRate": 0.00005,
            "clearingFeeRate": 0.00001, "regulatoryFeeRate": 0.00001,
            "vatRate": 0.07, "slippageBpsPerSide": 10, "minimumCommissionPerDay": 50,
        }
        self.assertGreater(side_cost(290, model), 53.5)

    @patch("pilot_capital_probe._gateway")
    def test_probe_returns_only_sanitized_sufficiency_facts(self, gateway):
        gateway.side_effect = [
            {
                "accountInfo": {"accountType": "CASH_BALANCE_FOR_TURNOVERLIST"},
                "cash": 10000, "cashVerified": True,
                "portfolio": [{"sym": "EXAMPLE", "qty": 10000, "mkt": 10}],
                "orders": [],
            },
            {"quote": {"marketStatus": "Open2", "last": 2.94, "bid": 2.92, "ask": 2.94}},
        ]
        result = evaluate(self.values(), "TTB", 100, 2.90)
        self.assertTrue(result["passed"])
        self.assertTrue(result["accountCapitalSufficient"])
        self.assertNotIn("cash", result)
        self.assertNotIn("portfolio", result)
        self.assertEqual(result["ordersCount"], 0)

    @patch("pilot_capital_probe._gateway")
    def test_probe_rejects_non_passive_price(self, gateway):
        gateway.side_effect = [
            {
                "accountInfo": {"accountType": "CASH_BALANCE"},
                "cash": 10000, "cashVerified": True, "portfolio": [], "orders": [],
            },
            {"quote": {"marketStatus": "Open", "last": 2.94, "bid": 2.92, "ask": 2.94}},
        ]
        with self.assertRaisesRegex(WorkerError, "PILOT_PRICE_NOT_PASSIVE"):
            evaluate(self.values(), "TTB", 100, 2.92)


if __name__ == "__main__":
    unittest.main()
