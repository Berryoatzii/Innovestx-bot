import unittest

from production_readonly_watchdog import (
    ProductionWatchdogError,
    run_watchdog_cycle,
)


class ProductionReadonlyWatchdogTests(unittest.TestCase):
    def test_healthy_readonly_gateway_is_not_restarted(self):
        starts = []
        result = run_watchdog_cycle(
            probe_gateway=lambda: {"status": "HEALTHY", "environment": "prod", "readOnly": True},
            listener_exists=lambda: True,
            account_lock_available=lambda: False,
            start_gateway=lambda: starts.append(True),
            wait_for_probe=lambda: {},
        )
        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(starts, [])

    def test_unhealthy_listener_is_never_killed_or_restarted(self):
        starts = []
        result = run_watchdog_cycle(
            probe_gateway=lambda: (_ for _ in ()).throw(ProductionWatchdogError("READ_FAILED")),
            listener_exists=lambda: True,
            account_lock_available=lambda: True,
            start_gateway=lambda: starts.append(True),
            wait_for_probe=lambda: {},
        )
        self.assertEqual(result["status"], "GATEWAY_UNHEALTHY")
        self.assertFalse(result["mutationAuthorized"])
        self.assertEqual(starts, [])

    def test_missing_gateway_restarts_only_with_available_account_lock(self):
        starts = []
        result = run_watchdog_cycle(
            probe_gateway=lambda: (_ for _ in ()).throw(ProductionWatchdogError("READ_FAILED")),
            listener_exists=lambda: False,
            account_lock_available=lambda: True,
            start_gateway=lambda: starts.append(True),
            wait_for_probe=lambda: {"status": "HEALTHY", "environment": "prod", "readOnly": True},
        )
        self.assertEqual(result["status"], "RESTARTED_HEALTHY")
        self.assertTrue(result["startedGateway"])
        self.assertEqual(starts, [True])

    def test_locked_account_fails_closed(self):
        result = run_watchdog_cycle(
            probe_gateway=lambda: (_ for _ in ()).throw(ProductionWatchdogError("READ_FAILED")),
            listener_exists=lambda: False,
            account_lock_available=lambda: False,
            start_gateway=lambda: self.fail("must not start"),
            wait_for_probe=lambda: {},
        )
        self.assertEqual(result["status"], "SESSION_LOCKED")


if __name__ == "__main__":
    unittest.main()
