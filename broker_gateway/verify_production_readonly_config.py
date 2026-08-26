"""Validate a production read-only credential file without contacting the broker."""

from __future__ import annotations

import sys
from pathlib import Path

from gateway import BrokerGatewayConfig, BrokerPolicyError, load_env_file


def main() -> int:
    if len(sys.argv) != 2:
        print("CONFIG_PATH_REQUIRED")
        return 2
    values: dict[str, str] = {}
    load_env_file(Path(sys.argv[1]), values)
    try:
        config = BrokerGatewayConfig.from_mapping(values)
    except (BrokerPolicyError, OSError, ValueError):
        print("PRODUCTION_READ_ONLY_CONFIG_INVALID")
        return 1
    if (
        config.environment != "prod"
        or not config.production_read_only
        or config.production_enabled
        or config.sdk_broker_id != "023"
        or config.cash_field != "cashBalance"
    ):
        print("PRODUCTION_READ_ONLY_GUARD_FAILED")
        return 1
    print("PRODUCTION_READ_ONLY_CONFIG_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
