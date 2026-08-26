import unittest

from production_readonly_probe import sanitized_evidence


class ProductionReadonlyProbeTests(unittest.TestCase):
    def test_sanitized_evidence_keeps_gate_facts_and_removes_positions(self):
        result = {
            "testedAt": "2026-08-26T07:42:00+00:00",
            "environment": "prod",
            "readOnly": True,
            "productionEnabled": False,
            "cashVerified": True,
            "accountType": "Cash Balance",
            "portfolioCount": 28,
            "portfolio": [{"sym": "EXAMPLE", "qty": 100}],
            "ordersCount": 0,
            "unresolvedCount": 0,
        }

        evidence = sanitized_evidence(result)

        self.assertNotIn("portfolio", evidence)
        self.assertEqual(evidence["portfolioCount"], 28)
        self.assertTrue(evidence["cashVerified"])
        self.assertEqual(evidence["accountType"], "Cash Balance")
        self.assertEqual(evidence["ordersCount"], 0)
        self.assertEqual(evidence["unresolvedCount"], 0)


if __name__ == "__main__":
    unittest.main()
