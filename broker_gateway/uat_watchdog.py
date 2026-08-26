"""UAT-only watchdog for the local broker gateway.

The watchdog never calls a mutation endpoint.  It can start one missing UAT
gateway, but it will not kill an unhealthy listener or break an account lock.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from gateway import (
    BrokerGatewayConfig,
    BrokerPolicyError,
    ProcessFence,
    _resolved_journal_path,
    load_env_file,
)
from verify_uat import VerificationError, verify_local_uat


class WatchdogError(RuntimeError):
    pass


@dataclass(frozen=True)
class WatchdogConfig:
    env_path: Path
    gateway_dir: Path
    python_exe: Path
    gateway_script: Path
    host: str
    port: int
    environment: str


def load_watchdog_config(env_path: str) -> WatchdogConfig:
    path = Path(env_path).resolve()
    values: dict[str, str] = {}
    load_env_file(str(path), values)
    environment = values.get("BROKER_ENVIRONMENT", "").strip().lower()
    if environment != "uat":
        raise WatchdogError("UAT_ONLY")
    if values.get("BROKER_PRODUCTION_ENABLED", "").strip().lower() != "false":
        raise WatchdogError("PRODUCTION_MUST_BE_DISABLED")
    host = values.get("BROKER_GATEWAY_HOST", "127.0.0.1").strip().lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise WatchdogError("LOOPBACK_ONLY")
    if not values.get("BROKER_GATEWAY_TOKEN", "").strip():
        raise WatchdogError("TOKEN_MISSING")
    try:
        port = int(values.get("BROKER_GATEWAY_PORT", "8787"))
    except ValueError as error:
        raise WatchdogError("PORT_INVALID") from error
    if port < 1 or port > 65535:
        raise WatchdogError("PORT_INVALID")

    gateway_dir = Path(__file__).resolve().parent
    python_exe = gateway_dir / ".venv" / "Scripts" / "python.exe"
    gateway_script = gateway_dir / "gateway.py"
    if not path.is_file() or not python_exe.is_file() or not gateway_script.is_file():
        raise WatchdogError("UAT_INSTALLATION_INCOMPLETE")
    return WatchdogConfig(
        env_path=path,
        gateway_dir=gateway_dir,
        python_exe=python_exe,
        gateway_script=gateway_script,
        host=host,
        port=port,
        environment=environment,
    )


def classify_summary(summary: Mapping[str, Any]) -> dict[str, Any]:
    if summary.get("environment") != "uat" or summary.get("gatewayReady") is not True:
        raise WatchdogError("UAT_SUMMARY_INVALID")
    positions = int(summary.get("positions", 0) or 0)
    orders = int(summary.get("orders", 0) or 0)
    recovery = summary.get("recovery") if isinstance(summary.get("recovery"), Mapping) else {}
    unresolved = int(recovery.get("count", 0) or 0)
    if unresolved:
        status = "RECONCILIATION_REQUIRED"
    elif positions or orders:
        status = "ATTENTION_REQUIRED"
    else:
        status = "HEALTHY"
    return {
        "status": status,
        "environment": "uat",
        "positions": positions,
        "orders": orders,
        "unresolved": unresolved,
        # Operational cleanliness is not authorization to trade.
        "safeToMutate": False,
        "mutationAuthorized": False,
    }


def run_watchdog_cycle(
    *,
    probe: Callable[[], Mapping[str, Any]],
    listener_exists: Callable[[], bool],
    account_lock_available: Callable[[], bool],
    start_gateway: Callable[[], None],
    wait_for_probe: Callable[[], Mapping[str, Any]],
) -> dict[str, Any]:
    try:
        return classify_summary(probe())
    except (WatchdogError, VerificationError):
        pass

    if listener_exists():
        return _failure("GATEWAY_UNHEALTHY")
    if not account_lock_available():
        return _failure("SESSION_LOCKED")
    try:
        start_gateway()
        result = classify_summary(wait_for_probe())
    except (OSError, subprocess.SubprocessError, WatchdogError, VerificationError):
        return _failure("RESTART_FAILED")
    result["status"] = f"RESTARTED_{result['status']}"
    result["startedGateway"] = True
    return result


def _failure(status: str) -> dict[str, Any]:
    return {
        "status": status,
        "environment": "uat",
        "safeToMutate": False,
        "mutationAuthorized": False,
        "startedGateway": False,
    }


def _listener_exists(host: str, port: int) -> bool:
    connect_host = "127.0.0.1" if host == "localhost" else host
    family = socket.AF_INET6 if connect_host == "::1" else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(0.4)
    try:
        return sock.connect_ex((connect_host, port)) == 0
    finally:
        sock.close()


def _account_lock_available(env_path: Path) -> bool:
    values: dict[str, str] = {}
    load_env_file(str(env_path), values)
    try:
        config = BrokerGatewayConfig.from_mapping(values)
        journal_path = _resolved_journal_path(config.journal_path)
        account_key = hashlib.sha256(
            f"{config.environment}:{config.sdk_broker_id}:{config.account_no}".encode("utf-8")
        ).hexdigest()[:16]
        fence = ProcessFence(str(journal_path.with_name(f".broker-gateway-{account_key}.lock")))
    except BrokerPolicyError as error:
        if str(error) == "GATEWAY_ALREADY_RUNNING_FOR_ACCOUNT":
            return False
        raise WatchdogError("UAT_CONFIG_INVALID") from error
    fence.close()
    return True


def _start_gateway(config: WatchdogConfig) -> None:
    environment = os.environ.copy()
    environment["BROKER_GATEWAY_ENV_FILE"] = str(config.env_path)
    stdout_path = config.gateway_dir / "gateway.stdout.log"
    stderr_path = config.gateway_dir / "gateway.stderr.log"
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    with stdout_path.open("ab") as stdout, stderr_path.open("ab") as stderr:
        subprocess.Popen(
            [str(config.python_exe), str(config.gateway_script)],
            cwd=str(config.gateway_dir),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            close_fds=True,
            creationflags=creationflags,
        )


def _wait_for_probe(env_path: Path) -> Mapping[str, Any]:
    last_error: Exception | None = None
    for _ in range(20):
        try:
            return verify_local_uat(str(env_path))
        except VerificationError as error:
            last_error = error
            time.sleep(0.5)
    raise WatchdogError("GATEWAY_START_TIMEOUT") from last_error


def record_result(status_path: Path, event_path: Path, result: Mapping[str, Any]) -> None:
    safe = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "status": str(result.get("status", "UNKNOWN"))[:64],
        "environment": "uat",
        "positions": int(result.get("positions", 0) or 0),
        "orders": int(result.get("orders", 0) or 0),
        "unresolved": int(result.get("unresolved", 0) or 0),
        "startedGateway": result.get("startedGateway") is True,
        "mutationAuthorized": False,
    }
    temporary = status_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(safe, indent=2), encoding="utf-8")
    os.replace(temporary, status_path)
    if safe["status"] != "HEALTHY":
        with event_path.open("a", encoding="utf-8") as events:
            events.write(json.dumps(safe, separators=(",", ":")) + "\n")


def main() -> int:
    env_path = os.environ.get("BROKER_GATEWAY_ENV_FILE", str(Path(__file__).with_name(".env")))
    status_path = Path(__file__).with_name(".uat-watchdog-status.json")
    event_path = Path(__file__).with_name(".uat-watchdog-events.jsonl")
    try:
        config = load_watchdog_config(env_path)
        result = run_watchdog_cycle(
            probe=lambda: verify_local_uat(str(config.env_path)),
            listener_exists=lambda: _listener_exists(config.host, config.port),
            account_lock_available=lambda: _account_lock_available(config.env_path),
            start_gateway=lambda: _start_gateway(config),
            wait_for_probe=lambda: _wait_for_probe(config.env_path),
        )
    except (OSError, WatchdogError, VerificationError):
        result = _failure("WATCHDOG_CONFIGURATION_ERROR")
    record_result(status_path, event_path, result)
    print(f"AEGIS UAT WATCHDOG: {result['status']}")
    return 0 if result["status"] in {"HEALTHY", "RESTARTED_HEALTHY"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
