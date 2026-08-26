"""Local-only UAT readiness report that never prints credential values."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Mapping


REQUIRED_UAT_KEYS = (
    "SETTRADE_APP_ID",
    "SETTRADE_APP_SECRET",
    "SETTRADE_APP_CODE",
    "SETTRADE_ACCOUNT_NO",
    "SETTRADE_PIN",
    "BROKER_GATEWAY_TOKEN",
)
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def configure_utf8_output(stream: Any) -> None:
    """Make Thai output reliable on legacy Windows console code pages."""
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8", errors="replace")


def _read_key_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def _sdk_environment(path: Path) -> str:
    return _read_key_values(path).get("environment", "").casefold()


def inspect_local_readiness(gateway_dir: Path, user_home: Path) -> dict[str, object]:
    """Inspect names/presence only; returned data never contains secret values."""
    gateway_dir = Path(gateway_dir)
    user_home = Path(user_home)
    env_path = gateway_dir / ".env"
    python_path = gateway_dir / ".venv" / "Scripts" / "python.exe"
    sdk_path = user_home / "AppData" / "settradesdkv2_config.txt"
    values = _read_key_values(env_path)
    environment = values.get("BROKER_ENVIRONMENT", "").casefold()
    host = values.get("BROKER_GATEWAY_HOST", "127.0.0.1").casefold()
    sdk_environment = _sdk_environment(sdk_path)

    blockers: list[str] = []
    dangerous = False
    if not python_path.is_file():
        blockers.append("ยังไม่ได้ติดตั้ง Settrade Gateway")
    if not env_path.is_file():
        blockers.append("ยังไม่มีข้อมูล Settrade UAT")
    elif any(not values.get(key) for key in REQUIRED_UAT_KEYS):
        blockers.append("ข้อมูล Settrade UAT ยังไม่ครบ")
    if env_path.is_file() and environment != "uat":
        blockers.append("Gateway ไม่ได้ตั้งเป็น UAT")
        dangerous = True
    if env_path.is_file() and host not in LOCAL_HOSTS:
        blockers.append("Gateway ไม่ได้จำกัดไว้ในเครื่อง")
        dangerous = True
    if values.get("BROKER_PRODUCTION_ENABLED", "false").casefold() != "false":
        blockers.append("พบการเปิด Production โดยไม่ผ่านขั้นทดสอบ")
        dangerous = True
    if sdk_environment != "uat":
        blockers.append("SDK ไม่ได้ตั้งเป็น UAT")
        dangerous = dangerous or sdk_environment == "prod"

    if dangerous:
        stage = "BLOCKED"
        next_action = "หยุดระบบและรัน setup_uat.ps1 ใหม่"
    elif blockers:
        stage = "SETUP_REQUIRED"
        next_action = "รัน setup_uat.ps1 แล้วกรอกข้อมูล Sandbox/UAT บนเครื่อง"
    else:
        stage = "UAT_CONFIGURED"
        next_action = "รัน check_uat.ps1 เพื่อทดสอบการอ่านบัญชีทดลอง"

    return {
        "stage": stage,
        "environment": environment or "not-configured",
        "sdkEnvironment": sdk_environment or "not-configured",
        "gatewayInstalled": python_path.is_file(),
        "credentialsPresent": env_path.is_file() and all(values.get(key) for key in REQUIRED_UAT_KEYS),
        "localOnly": host in LOCAL_HOSTS,
        "productionLocked": values.get("BROKER_PRODUCTION_ENABLED", "false").casefold() == "false",
        "blockers": blockers,
        "nextAction": next_action,
        "realMoney": "REAL-NO-GO",
    }


def _print_report(report: Mapping[str, object]) -> None:
    labels = {
        "BLOCKED": "หยุด — การตั้งค่าไม่ปลอดภัย",
        "SETUP_REQUIRED": "ยังต้องตั้งค่า UAT",
        "UAT_CONFIGURED": "ตั้งค่า UAT แล้ว — พร้อมตรวจแบบอ่านอย่างเดียว",
    }
    print("\nTHAI STOCK BOT — รายงานความพร้อม")
    print(f"สถานะ: {labels.get(str(report['stage']), report['stage'])}")
    print(f"Gateway: {'พร้อม' if report['gatewayInstalled'] else 'ยังไม่พร้อม'}")
    print(f"ข้อมูล UAT: {'มีครบ' if report['credentialsPresent'] else 'ยังไม่ครบ'}")
    print(f"SDK: {report['sdkEnvironment']}")
    print(f"บัญชีจริง: {report['realMoney']}")
    for blocker in report["blockers"]:
        print(f"- {blocker}")
    print(f"ทำต่อ: {report['nextAction']}")
    print("รายงานนี้ไม่แสดงรหัส PIN, Secret, Token หรือเลขบัญชี")


def main() -> int:
    configure_utf8_output(sys.stdout)
    configure_utf8_output(sys.stderr)
    gateway_dir = Path(__file__).resolve().parent
    user_home = Path(os.environ.get("USERPROFILE", str(Path.home())))
    report = inspect_local_readiness(gateway_dir, user_home)
    _print_report(report)
    return 0 if report["stage"] == "UAT_CONFIGURED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
