"""Lock the cash controls discovered from the official Sandbox schema.

This helper never prints credentials and refuses production files.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


EXPECTED = {
    "BROKER_CASH_FIELD": "cashBalance",
    "BROKER_REQUIRED_ACCOUNT_TYPE": "CASH_ACCOUNT",
}


def locked_lines(lines: list[str]) -> list[str]:
    values: dict[str, str] = {}
    for raw in lines:
        if "=" in raw and not raw.lstrip().startswith("#"):
            key, value = raw.split("=", 1)
            values[key.strip()] = value.strip()
    if values.get("BROKER_ENVIRONMENT", "").lower() != "uat":
        raise RuntimeError("UAT_ONLY")
    if values.get("BROKER_PRODUCTION_ENABLED", "").lower() == "true":
        raise RuntimeError("PRODUCTION_MUST_REMAIN_DISABLED")
    for key, expected in EXPECTED.items():
        current = values.get(key, "")
        if current and current != expected:
            raise RuntimeError(f"{key}_CONFLICT")

    seen: set[str] = set()
    output: list[str] = []
    for raw in lines:
        key = raw.split("=", 1)[0].strip() if "=" in raw else ""
        if key in EXPECTED:
            output.append(f"{key}={EXPECTED[key]}")
            seen.add(key)
        else:
            output.append(raw)
    for key, value in EXPECTED.items():
        if key not in seen:
            output.append(f"{key}={value}")
    return output


def main() -> int:
    path = Path(os.environ.get("BROKER_GATEWAY_ENV_FILE", Path(__file__).with_name(".env")))
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    output = locked_lines(lines)
    fd, temporary = tempfile.mkstemp(prefix=".env.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(output) + "\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("UAT cash controls locked: cashBalance + CASH_ACCOUNT")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
