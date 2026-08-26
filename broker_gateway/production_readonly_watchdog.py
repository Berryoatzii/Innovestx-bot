"""Production read-only watchdog.

It may start a missing loopback gateway configured with production mutations
disabled. It never calls POST/PUT/DELETE, never kills an unhealthy listener,
and refuses any production order unlock in the env file.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.request import Request, urlopen

from gateway import (
    BrokerGatewayConfig,
    BrokerPolicyError,
    BrokerService,
    ProcessFence,
    _resolved_journal_path,
    load_env_file,
)


class ProductionWatchdogError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProductionWatchdogConfig:
    env_path: Path
    gateway_dir: Path
    python_exe: Path
    gateway_script: Path
    host: str
    port: int
    token: str


def load_production_watchdog_config(env_path: str) -> ProductionWatchdogConfig:
    path = Path(env_path).resolve()
    values: dict[str, str] = {}
    load_env_file(str(path), values)
    if values.get("BROKER_ENVIRONMENT", "").strip().lower() != "prod":
        raise ProductionWatchdogError("PRODUCTION_ONLY")
    if values.get("BROKER_PRODUCTION_READ_ONLY", "").strip().lower() != "true":
        raise ProductionWatchdogError("READ_ONLY_REQUIRED")
    if values.get("BROKER_PRODUCTION_ENABLED", "").strip().lower() != "false":
        raise ProductionWatchdogError("PRODUCTION_MUTATIONS_MUST_BE_DISABLED")
    if values.get("BROKER_PRODUCTION_ACK") or values.get("BROKER_PRODUCTION_CONFIRMATION"):
        raise ProductionWatchdogError("ORDER_UNLOCKS_FORBIDDEN")
    host = values.get("BROKER_GATEWAY_HOST", "127.0.0.1").strip().lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ProductionWatchdogError("LOOPBACK_ONLY")
    token = values.get("BROKER_GATEWAY_TOKEN", "").strip()
    if not token:
        raise ProductionWatchdogError("TOKEN_MISSING")
    try:
        port = int(values.get("BROKER_GATEWAY_PORT", "8788"))
    except ValueError as error:
        raise ProductionWatchdogError("PORT_INVALID") from error
    if port < 1 or port > 65535:
        raise ProductionWatchdogError("PORT_INVALID")
    gateway_dir = Path(__file__).resolve().parent
    python_exe = gateway_dir / ".venv" / "Scripts" / "python.exe"
    gateway_script = gateway_dir / "gateway.py"
    if not path.is_file() or not python_exe.is_file() or not gateway_script.is_file():
        raise ProductionWatchdogError("INSTALLATION_INCOMPLETE")
    return ProductionWatchdogConfig(path, gateway_dir, python_exe, gateway_script, host, port, token)


def _request_json(config: ProductionWatchdogConfig, path: str) -> Mapping[str, Any]:
    display_host = f"[{config.host}]" if config.host == "::1" else config.host
    request = Request(
        f"http://{display_host}:{config.port}{path}",
        method="GET",
        headers={"Authorization": f"Bearer {config.token}", "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            value = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise ProductionWatchdogError(f"READ_FAILED:{type(error).__name__}") from error
    if not isinstance(value, Mapping):
        raise ProductionWatchdogError("INVALID_JSON")
    return value


def probe(config: ProductionWatchdogConfig) -> dict[str, Any]:
    health = _request_json(config, "/v1/health")
    snapshot = _request_json(config, "/v1/account-snapshot")
    unresolved_payload = _request_json(config, "/v1/journal/unresolved")
    if health.get("ok") is not True or health.get("environment") != "prod":
        raise ProductionWatchdogError("HEALTH_INVALID")
    if snapshot.get("ok") is not True or snapshot.get("environment") != "prod":
        raise ProductionWatchdogError("SNAPSHOT_INVALID")
    health_data = health.get("data") if isinstance(health.get("data"), Mapping) else {}
    data = snapshot.get("data") if isinstance(snapshot.get("data"), Mapping) else {}
    unresolved_data = unresolved_payload.get("data") if isinstance(unresolved_payload.get("data"), Mapping) else {}
    orders = data.get("orders") if isinstance(data.get("orders"), list) else []
    open_orders = [item for item in orders if not BrokerService._is_terminal_order(item)]
    unresolved = unresolved_data.get("operations") if isinstance(unresolved_data.get("operations"), list) else []
    if health_data.get("ready") is not True or data.get("cashVerified") is not True:
        raise ProductionWatchdogError("PRODUCTION_READONLY_NOT_READY")
    status = "RECONCILIATION_REQUIRED" if unresolved else "ATTENTION_REQUIRED" if open_orders else "HEALTHY"
    return {
        "status": status,
        "environment": "prod",
        "readOnly": True,
        "portfolioCount": len(data.get("portfolio") or []),
        "openOrders": len(open_orders),
        "unresolved": len(unresolved),
        "mutationAuthorized": False,
    }


def run_watchdog_cycle(
    *,
    probe_gateway: Callable[[], Mapping[str, Any]],
    listener_exists: Callable[[], bool],
    account_lock_available: Callable[[], bool],
    start_gateway: Callable[[], None],
    wait_for_probe: Callable[[], Mapping[str, Any]],
) -> dict[str, Any]:
    try:
        return dict(probe_gateway())
    except ProductionWatchdogError:
        pass
    if listener_exists():
        return failure("GATEWAY_UNHEALTHY")
    if not account_lock_available():
        return failure("SESSION_LOCKED")
    try:
        start_gateway()
        result = dict(wait_for_probe())
    except (OSError, subprocess.SubprocessError, ProductionWatchdogError):
        return failure("RESTART_FAILED")
    result["status"] = f"RESTARTED_{result['status']}"
    result["startedGateway"] = True
    return result


def failure(status: str) -> dict[str, Any]:
    return {
        "status": status,
        "environment": "prod",
        "readOnly": True,
        "startedGateway": False,
        "mutationAuthorized": False,
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
        raise ProductionWatchdogError("CONFIG_INVALID") from error
    fence.close()
    return True


def _start_gateway(config: ProductionWatchdogConfig) -> None:
    environment = os.environ.copy()
    environment["BROKER_GATEWAY_ENV_FILE"] = str(config.env_path)
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with (config.gateway_dir / "production-readonly.stdout.log").open("ab") as stdout, \
         (config.gateway_dir / "production-readonly.stderr.log").open("ab") as stderr:
        subprocess.Popen(
            [str(config.python_exe), str(config.gateway_script)],
            cwd=str(config.gateway_dir), env=environment, stdin=subprocess.DEVNULL,
            stdout=stdout, stderr=stderr, close_fds=True, creationflags=creationflags,
        )


def _wait_for_probe(config: ProductionWatchdogConfig) -> Mapping[str, Any]:
    last_error: Exception | None = None
    for _ in range(30):
        try:
            return probe(config)
        except ProductionWatchdogError as error:
            last_error = error
            time.sleep(0.5)
    raise ProductionWatchdogError("GATEWAY_START_TIMEOUT") from last_error


def record_result(path: Path, result: Mapping[str, Any]) -> None:
    safe = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "status": str(result.get("status", "UNKNOWN"))[:64],
        "environment": "prod",
        "readOnly": True,
        "portfolioCount": int(result.get("portfolioCount", 0) or 0),
        "openOrders": int(result.get("openOrders", 0) or 0),
        "unresolved": int(result.get("unresolved", 0) or 0),
        "startedGateway": result.get("startedGateway") is True,
        "mutationAuthorized": False,
    }
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(safe, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def main() -> int:
    env_path = os.environ.get(
        "BROKER_GATEWAY_ENV_FILE",
        str(Path(__file__).with_name(".env.production-readonly")),
    )
    status_path = Path(__file__).with_name(".production-readonly-watchdog-status.json")
    try:
        config = load_production_watchdog_config(env_path)
        result = run_watchdog_cycle(
            probe_gateway=lambda: probe(config),
            listener_exists=lambda: _listener_exists(config.host, config.port),
            account_lock_available=lambda: _account_lock_available(config.env_path),
            start_gateway=lambda: _start_gateway(config),
            wait_for_probe=lambda: _wait_for_probe(config),
        )
    except (OSError, ProductionWatchdogError):
        result = failure("WATCHDOG_CONFIGURATION_ERROR")
    record_result(status_path, result)
    print(f"AEGIS PRODUCTION READ-ONLY WATCHDOG: {result['status']}")
    return 0 if result["status"] in {"HEALTHY", "RESTARTED_HEALTHY"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
