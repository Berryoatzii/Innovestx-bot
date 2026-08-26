import tempfile
import unittest
from pathlib import Path

from uat_watchdog import (
    WatchdogError,
    record_result,
    classify_summary,
    load_watchdog_config,
    run_watchdog_cycle,
)


class UatWatchdogTests(unittest.TestCase):
    def _env_file(self, directory: str, **overrides: str) -> str:
        values = {
            "BROKER_ENVIRONMENT": "uat",
            "BROKER_PRODUCTION_ENABLED": "false",
            "BROKER_GATEWAY_HOST": "127.0.0.1",
            "BROKER_GATEWAY_PORT": "8787",
            "BROKER_GATEWAY_TOKEN": "private-local-token",
        }
        values.update(overrides)
        path = Path(directory) / ".env"
        path.write_text("\n".join(f"{key}={value}" for key, value in values.items()), encoding="utf-8")
        return str(path)

    def test_configuration_is_strictly_uat_loopback_and_production_off(self):
        with tempfile.TemporaryDirectory() as directory:
            config = load_watchdog_config(self._env_file(directory))
            self.assertEqual(config.environment, "uat")
            self.assertEqual(config.host, "127.0.0.1")

            for overrides in (
                {"BROKER_ENVIRONMENT": "prod"},
                {"BROKER_PRODUCTION_ENABLED": "true"},
                {"BROKER_GATEWAY_HOST": "0.0.0.0"},
            ):
                with self.subTest(overrides=overrides):
                    with self.assertRaises(WatchdogError):
                        load_watchdog_config(self._env_file(directory, **overrides))

    def test_clean_summary_is_healthy_but_positions_or_orders_require_attention(self):
        clean = {
            "environment": "uat",
            "gatewayReady": True,
            "positions": 0,
            "orders": 0,
            "recovery": {"count": 0},
        }
        self.assertEqual(classify_summary(clean)["status"], "HEALTHY")

        for field in ("positions", "orders"):
            changed = dict(clean, **{field: 1})
            with self.subTest(field=field):
                result = classify_summary(changed)
                self.assertEqual(result["status"], "ATTENTION_REQUIRED")
                self.assertFalse(result["safeToMutate"])

        unresolved = dict(clean, recovery={"count": 1})
        result = classify_summary(unresolved)
        self.assertEqual(result["status"], "RECONCILIATION_REQUIRED")
        self.assertFalse(result["safeToMutate"])

    def test_healthy_gateway_is_never_restarted(self):
        starts = []
        summary = {
            "environment": "uat", "gatewayReady": True,
            "positions": 0, "orders": 0, "recovery": {"count": 0},
        }
        result = run_watchdog_cycle(
            probe=lambda: summary,
            listener_exists=lambda: True,
            account_lock_available=lambda: False,
            start_gateway=lambda: starts.append(True),
            wait_for_probe=lambda: summary,
        )
        self.assertEqual(result["status"], "HEALTHY")
        self.assertEqual(starts, [])

    def test_unhealthy_listener_is_not_killed_or_restarted(self):
        starts = []

        def unavailable():
            raise WatchdogError("GATEWAY_UNAVAILABLE")

        result = run_watchdog_cycle(
            probe=unavailable,
            listener_exists=lambda: True,
            account_lock_available=lambda: False,
            start_gateway=lambda: starts.append(True),
            wait_for_probe=unavailable,
        )
        self.assertEqual(result["status"], "GATEWAY_UNHEALTHY")
        self.assertEqual(starts, [])

    def test_absent_gateway_starts_once_only_when_account_lock_is_free(self):
        starts = []
        summary = {
            "environment": "uat", "gatewayReady": True,
            "positions": 0, "orders": 0, "recovery": {"count": 0},
        }

        def unavailable():
            raise WatchdogError("GATEWAY_UNAVAILABLE")

        result = run_watchdog_cycle(
            probe=unavailable,
            listener_exists=lambda: False,
            account_lock_available=lambda: True,
            start_gateway=lambda: starts.append(True),
            wait_for_probe=lambda: summary,
        )
        self.assertEqual(result["status"], "RESTARTED_HEALTHY")
        self.assertEqual(starts, [True])

        starts.clear()
        result = run_watchdog_cycle(
            probe=unavailable,
            listener_exists=lambda: False,
            account_lock_available=lambda: False,
            start_gateway=lambda: starts.append(True),
            wait_for_probe=lambda: summary,
        )
        self.assertEqual(result["status"], "SESSION_LOCKED")
        self.assertEqual(starts, [])

    def test_restarted_gateway_with_positions_is_flagged_not_declared_safe(self):
        def unavailable():
            raise WatchdogError("GATEWAY_UNAVAILABLE")

        summary = {
            "environment": "uat", "gatewayReady": True,
            "positions": 1, "orders": 0, "recovery": {"count": 0},
        }
        result = run_watchdog_cycle(
            probe=unavailable,
            listener_exists=lambda: False,
            account_lock_available=lambda: True,
            start_gateway=lambda: None,
            wait_for_probe=lambda: summary,
        )
        self.assertEqual(result["status"], "RESTARTED_ATTENTION_REQUIRED")
        self.assertFalse(result["safeToMutate"])

    def test_restart_event_is_persisted_without_secrets_but_plain_health_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            status_path = Path(directory) / "status.json"
            event_path = Path(directory) / "events.jsonl"
            record_result(status_path, event_path, {
                "status": "HEALTHY", "positions": 0, "orders": 0, "unresolved": 0,
                "accountNo": "SECRET", "token": "PRIVATE",
            })
            self.assertFalse(event_path.exists())

            record_result(status_path, event_path, {
                "status": "RESTARTED_HEALTHY", "positions": 0, "orders": 0, "unresolved": 0,
                "startedGateway": True, "accountNo": "SECRET", "token": "PRIVATE",
            })
            serialized = status_path.read_text(encoding="utf-8") + event_path.read_text(encoding="utf-8")
            self.assertIn("RESTARTED_HEALTHY", serialized)
            self.assertNotIn("SECRET", serialized)
            self.assertNotIn("PRIVATE", serialized)


if __name__ == "__main__":
    unittest.main()
