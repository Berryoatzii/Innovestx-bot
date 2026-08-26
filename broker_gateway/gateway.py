"""Single-session Settrade SDK V2 broker gateway.

The gateway is intentionally single-process and fail-closed.  UAT is the
default development target; production needs separate explicit unlocks.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Mapping, MutableMapping, Optional
from urllib.parse import urlparse


PRODUCTION_ACK = "I_ACCEPT_REAL_ORDER_RESPONSIBILITY"
SYMBOL_RE = re.compile(r"^[A-Z0-9._-]{1,20}$")
SENSITIVE_SCHEMA_FIELDS = {
    "accountno", "accountnumber", "pin", "password", "secret", "token",
    "appid", "appsecret", "apikey", "userid", "username",
}


class BrokerPolicyError(RuntimeError):
    pass


class ExecutionUncertainError(RuntimeError):
    pass


class ProcessFence:
    """Non-blocking OS lock preventing two gateways from sharing credentials."""

    def __init__(self, path: str):
        self.path = str(Path(path).resolve())
        self._file = open(self.path, "a+b")
        self._locked = False
        try:
            self._file.seek(0, os.SEEK_END)
            if self._file.tell() == 0:
                self._file.write(b"\0")
                self._file.flush()
            self._file.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._locked = True
        except (OSError, BlockingIOError) as error:
            self._file.close()
            raise BrokerPolicyError("GATEWAY_ALREADY_RUNNING_FOR_ACCOUNT") from error

    def close(self) -> None:
        if self._file.closed:
            return
        try:
            if self._locked:
                self._file.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._locked = False
            self._file.close()


def load_env_file(path: str, target: MutableMapping[str, str] = os.environ) -> None:
    """Load a local secret file without printing values or overriding real env."""
    env_path = Path(path)
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        target.setdefault(key, value)


def _required(values: Mapping[str, str], name: str) -> str:
    value = str(values.get(name, "")).strip()
    if not value:
        raise BrokerPolicyError(f"MISSING_{name}")
    return value


def parse_board_lot_overrides(values: Mapping[str, str]) -> dict[str, int]:
    """Parse exact-symbol lot overrides; malformed policy must stop startup."""
    raw = str(values.get("BROKER_BOARD_LOT_OVERRIDES_JSON", "") or "").strip()
    if not raw:
        return {}
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise BrokerPolicyError("BROKER_BOARD_LOT_OVERRIDES_INVALID") from error
    if not isinstance(decoded, dict):
        raise BrokerPolicyError("BROKER_BOARD_LOT_OVERRIDES_INVALID")

    overrides: dict[str, int] = {}
    for raw_symbol, lot in decoded.items():
        symbol = str(raw_symbol).upper().strip()
        if (
            not SYMBOL_RE.fullmatch(symbol)
            or isinstance(lot, bool)
            or not isinstance(lot, int)
            or lot <= 0
        ):
            raise BrokerPolicyError("BROKER_BOARD_LOT_OVERRIDES_INVALID")
        overrides[symbol] = lot
    return overrides


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class BrokerGatewayConfig:
    environment: str
    app_id: str
    app_secret: str
    app_code: str
    broker_id: str
    account_no: str
    pin: str
    gateway_token: str
    max_order_value: float
    cash_field: str
    required_account_type: str
    board_lot: int
    board_lot_overrides: Mapping[str, int]
    cash_buffer_bps: float
    journal_path: str
    production_read_only: bool
    production_enabled: bool
    production_confirmation: str
    connect_timeout_seconds: float
    read_timeout_seconds: float

    @property
    def sdk_broker_id(self) -> str:
        return "SANDBOX" if self.environment == "uat" else self.broker_id

    def board_lot_for(self, symbol: str) -> int:
        normalized = str(symbol).upper().strip()
        return self.board_lot_overrides.get(normalized, self.board_lot)

    @classmethod
    def from_mapping(cls, values: Mapping[str, str]) -> "BrokerGatewayConfig":
        environment = str(values.get("BROKER_ENVIRONMENT", "")).strip().lower()
        if environment not in {"uat", "prod"}:
            raise BrokerPolicyError("BROKER_ENVIRONMENT_MUST_BE_UAT_OR_PROD")

        production_read_only = str(values.get("BROKER_PRODUCTION_READ_ONLY", "")).lower() == "true"
        production_enabled = str(values.get("BROKER_PRODUCTION_ENABLED", "")).lower() == "true"
        production_ack = str(values.get("BROKER_PRODUCTION_ACK", ""))
        production_confirmation = str(values.get("BROKER_PRODUCTION_CONFIRMATION", ""))
        broker_id = str(values.get("SETTRADE_BROKER_ID", "")).strip()

        if environment == "prod":
            if not broker_id or broker_id.upper() == "SANDBOX":
                raise BrokerPolicyError("PRODUCTION_BROKER_ID_REQUIRED")
            if production_enabled:
                if production_read_only:
                    raise BrokerPolicyError("PRODUCTION_MODE_CONFLICT")
                if production_ack != PRODUCTION_ACK:
                    raise BrokerPolicyError("PRODUCTION_ACK_REQUIRED")
                if not production_confirmation:
                    raise BrokerPolicyError("PRODUCTION_CONFIRMATION_REQUIRED")
            elif not production_read_only:
                raise BrokerPolicyError("PRODUCTION_DISABLED")
            elif production_ack or production_confirmation:
                raise BrokerPolicyError("PRODUCTION_READ_ONLY_MUST_NOT_HAVE_ORDER_UNLOCKS")

        cash_field = str(values.get("BROKER_CASH_FIELD", "")).strip()
        required_account_type = str(values.get("BROKER_REQUIRED_ACCOUNT_TYPE", "")).strip()
        if environment == "prod" and production_enabled and (not cash_field or not required_account_type):
            raise BrokerPolicyError("PRODUCTION_CASH_CONTROLS_REQUIRED")

        max_order_value = float(values.get("BROKER_MAX_ORDER_VALUE", "0") or 0)
        if not math.isfinite(max_order_value) or max_order_value <= 0:
            raise BrokerPolicyError("BROKER_MAX_ORDER_VALUE_REQUIRED")

        try:
            board_lot = int(values.get("BROKER_BOARD_LOT", "100") or 0)
        except (TypeError, ValueError) as error:
            raise BrokerPolicyError("BROKER_BOARD_LOT_INVALID") from error
        if board_lot <= 0:
            raise BrokerPolicyError("BROKER_BOARD_LOT_INVALID")
        board_lot_overrides = parse_board_lot_overrides(values)
        cash_buffer_bps = float(values.get("BROKER_CASH_BUFFER_BPS", "100") or 0)
        if not math.isfinite(cash_buffer_bps) or cash_buffer_bps < 0 or cash_buffer_bps > 2000:
            raise BrokerPolicyError("BROKER_CASH_BUFFER_BPS_INVALID")

        token = _required(values, "BROKER_GATEWAY_TOKEN")
        if len(token) < 12:
            raise BrokerPolicyError("BROKER_GATEWAY_TOKEN_TOO_SHORT")

        return cls(
            environment=environment,
            app_id=_required(values, "SETTRADE_APP_ID"),
            app_secret=_required(values, "SETTRADE_APP_SECRET"),
            app_code=_required(values, "SETTRADE_APP_CODE"),
            broker_id=broker_id,
            account_no=_required(values, "SETTRADE_ACCOUNT_NO"),
            pin=_required(values, "SETTRADE_PIN"),
            gateway_token=token,
            max_order_value=max_order_value,
            cash_field=cash_field,
            required_account_type=required_account_type,
            board_lot=board_lot,
            board_lot_overrides=board_lot_overrides,
            cash_buffer_bps=cash_buffer_bps,
            journal_path=str(values.get("BROKER_JOURNAL_PATH", "broker-journal.sqlite3")),
            production_read_only=production_read_only,
            production_enabled=production_enabled,
            production_confirmation=production_confirmation,
            connect_timeout_seconds=float(values.get("BROKER_CONNECT_TIMEOUT_SECONDS", "5")),
            read_timeout_seconds=float(values.get("BROKER_READ_TIMEOUT_SECONDS", "15")),
        )


class BrokerJournal:
    """Durable idempotency ledger written before every broker mutation."""

    def __init__(self, path: str):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS operations (
              request_id TEXT PRIMARY KEY,
              operation TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              status TEXT NOT NULL,
              order_no TEXT,
              response_json TEXT,
              error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(operations)").fetchall()}
        if "request_json" not in columns:
            self._db.execute("ALTER TABLE operations ADD COLUMN request_json TEXT")

    def close(self) -> None:
        self._db.close()

    @staticmethod
    def _safe_request(operation: str, request: Optional[Mapping[str, Any]]) -> dict[str, Any]:
        item = request if isinstance(request, Mapping) else {}
        if operation == "PLACE":
            return {
                "symbol": str(item.get("symbol", "")).upper()[:20],
                "side": str(item.get("side", "")).upper()[:4],
                "quantity": int(item.get("quantity", 0) or 0),
                "price": float(item.get("price", 0) or 0),
            }
        if operation == "CANCEL":
            return {"orderNo": str(item.get("orderNo", ""))[:128]}
        return {}

    def reserve(
        self,
        request_id: str,
        operation: str,
        fingerprint: str,
        *,
        request: Optional[Mapping[str, Any]] = None,
    ) -> tuple[dict[str, Any], bool]:
        request_id = str(request_id).strip()
        if not request_id or len(request_id) > 128:
            raise BrokerPolicyError("INVALID_IDEMPOTENCY_KEY")
        now = _utc_now()
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute(
                    "SELECT * FROM operations WHERE request_id = ?", (request_id,)
                ).fetchone()
                if row:
                    existing = dict(row)
                    if existing["operation"] != operation or existing["fingerprint"] != fingerprint:
                        raise BrokerPolicyError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST")
                    self._db.execute("COMMIT")
                    return existing, False
                unresolved = self._db.execute(
                    """SELECT request_id FROM operations
                    WHERE status IN ('SUBMITTING', 'EXECUTION_UNCERTAIN')
                    LIMIT 1"""
                ).fetchone()
                if unresolved:
                    raise BrokerPolicyError("MUTATIONS_FROZEN_UNRESOLVED")
                self._db.execute(
                    """INSERT INTO operations
                    (request_id, operation, fingerprint, status, request_json, created_at, updated_at)
                    VALUES (?, ?, ?, 'SUBMITTING', ?, ?, ?)""",
                    (
                        request_id,
                        operation,
                        fingerprint,
                        json.dumps(self._safe_request(operation, request), separators=(",", ":")),
                        now,
                        now,
                    ),
                )
                self._db.execute("COMMIT")
                return {
                    "request_id": request_id,
                    "operation": operation,
                    "fingerprint": fingerprint,
                    "status": "SUBMITTING",
                    "created_at": now,
                    "updated_at": now,
                }, True
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def find(self, request_id: str) -> Optional[dict[str, Any]]:
        request_id = str(request_id).strip()
        if not request_id or len(request_id) > 128:
            raise BrokerPolicyError("INVALID_IDEMPOTENCY_KEY")
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM operations WHERE request_id = ?", (request_id,)
            ).fetchone()
        return dict(row) if row else None

    def update(
        self,
        request_id: str,
        status: str,
        *,
        order_no: Optional[str] = None,
        response: Optional[dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        with self._lock:
            self._db.execute(
                """UPDATE operations
                SET status = ?, order_no = ?, response_json = ?, error = ?, updated_at = ?
                WHERE request_id = ?""",
                (
                    status,
                    order_no,
                    json.dumps(response, ensure_ascii=False, default=str) if response is not None else None,
                    str(error)[:500] if error else None,
                    _utc_now(),
                    request_id,
                ),
            )

    def list_unresolved(self) -> list[dict[str, Any]]:
        """Return only identifiers/status needed for manual reconciliation."""
        with self._lock:
            rows = self._db.execute(
                """SELECT request_id, operation, status, order_no, request_json, created_at, updated_at
                FROM operations
                WHERE status IN ('SUBMITTING', 'EXECUTION_UNCERTAIN')
                ORDER BY created_at ASC"""
            ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            try:
                safe_request = self._safe_request(
                    str(row["operation"]), json.loads(str(row["request_json"] or "{}"))
                )
            except (TypeError, ValueError, json.JSONDecodeError):
                safe_request = {}
            result.append({
                "requestId": str(row["request_id"]),
                "operation": str(row["operation"]),
                "status": str(row["status"]),
                "orderNo": str(row["order_no"]) if row["order_no"] is not None else None,
                "order": safe_request,
                "createdAt": str(row["created_at"]),
                "updatedAt": str(row["updated_at"]),
            })
        return result

    def has_unresolved(self) -> bool:
        with self._lock:
            row = self._db.execute(
                """SELECT 1 FROM operations
                WHERE status IN ('SUBMITTING', 'EXECUTION_UNCERTAIN')
                LIMIT 1"""
            ).fetchone()
        return row is not None

    def resolve_no_candidate(self, request_id: str, *, proof: Mapping[str, Any]) -> None:
        """Close one UAT PLACE ambiguity after independent broker reads prove no candidate."""
        request_id = str(request_id).strip()
        samples = proof.get("samples") if isinstance(proof, Mapping) else None
        if (
            not request_id
            or not isinstance(samples, list)
            or len(samples) < 3
            or any(
                not isinstance(item, Mapping)
                or item.get("classification") != "NO_CANDIDATE"
                or item.get("positions") != 0
                or item.get("orders") != 0
                for item in samples
            )
        ):
            raise BrokerPolicyError("NO_CANDIDATE_PROOF_REQUIRED")
        safe_proof = {
            "classification": "NO_CANDIDATE",
            "sampleCount": len(samples),
            "checkedAt": str(proof.get("checkedAt", ""))[:64],
        }
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute(
                    "SELECT operation, status FROM operations WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if row is None:
                    raise BrokerPolicyError("RECONCILIATION_REQUEST_NOT_FOUND")
                if row["operation"] != "PLACE" or row["status"] not in {
                    "SUBMITTING", "EXECUTION_UNCERTAIN"
                }:
                    raise BrokerPolicyError("RECONCILIATION_NOT_ALLOWED")
                self._db.execute(
                    """UPDATE operations
                    SET status = 'RECONCILED_NO_CANDIDATE', response_json = ?,
                        updated_at = ? WHERE request_id = ?""",
                    (json.dumps(safe_proof, separators=(",", ":")), _utc_now(), request_id),
                )
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def resolve_terminal_cancel(self, request_id: str, *, proof: Mapping[str, Any]) -> None:
        """Close one UAT CANCEL ambiguity after repeated terminal broker proof."""
        request_id = str(request_id).strip()
        samples = proof.get("samples") if isinstance(proof, Mapping) else None
        valid_statuses = {"c", "cx", "cancelled", "canceled"}
        if (
            not request_id
            or not isinstance(samples, list)
            or len(samples) < 3
            or any(
                not isinstance(item, Mapping)
                or str(item.get("status", "")).strip().casefold() not in valid_statuses
                or item.get("canCancel") is not False
                or float(item.get("quantity", 0) or 0) <= 0
                or float(item.get("matchedQuantity", 0) or 0) != 0
                or float(item.get("cancelled", 0) or 0)
                    < float(item.get("quantity", 0) or 0)
                for item in samples
            )
        ):
            raise BrokerPolicyError("TERMINAL_CANCEL_PROOF_REQUIRED")
        safe_proof = {
            "classification": "TERMINAL_CANCELLED_NO_FILL",
            "sampleCount": len(samples),
            "checkedAt": str(proof.get("checkedAt", ""))[:64],
        }
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute(
                    "SELECT operation, status FROM operations WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if row is None:
                    raise BrokerPolicyError("RECONCILIATION_REQUEST_NOT_FOUND")
                if row["operation"] != "CANCEL" or row["status"] not in {
                    "SUBMITTING", "EXECUTION_UNCERTAIN"
                }:
                    raise BrokerPolicyError("RECONCILIATION_NOT_ALLOWED")
                self._db.execute(
                    """UPDATE operations
                    SET status = 'RECONCILED_CANCELLED', response_json = ?,
                        updated_at = ? WHERE request_id = ?""",
                    (json.dumps(safe_proof, separators=(",", ":")), _utc_now(), request_id),
                )
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise


def _fingerprint(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _decode_response(row: Mapping[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(str(row.get("response_json") or "{}"))
    except json.JSONDecodeError:
        return {}


def _field(data: Mapping[str, Any], dotted_path: str) -> Any:
    current: Any = data
    for part in dotted_path.split(".") if dotted_path else []:
        if not isinstance(current, Mapping) or part not in current:
            return None
        current = current[part]
    return current


def _safe_error_name(error: BaseException) -> str:
    """Persist only a class plus sanitized SDK code/status, never its message."""
    name = type(error).__name__[:60]
    raw_code = getattr(error, "code", "")
    code = re.sub(r"[^A-Za-z0-9_.:-]", "", str(raw_code or ""))[:60]
    raw_status = getattr(error, "status_code", None)
    status = str(raw_status) if isinstance(raw_status, int) and not isinstance(raw_status, bool) else ""
    return ":".join(part for part in (name, status, code) if part)[:120]


def _is_definite_broker_rejection(error: BaseException) -> bool:
    """A completed non-retryable 4xx response proves the broker rejected it."""
    if type(error).__name__ != "SettradeError":
        return False
    status = getattr(error, "status_code", None)
    return (
        isinstance(status, int)
        and not isinstance(status, bool)
        and 400 <= status < 500
        and status not in {408, 409, 425, 429}
    )


class BrokerService:
    def __init__(self, config: BrokerGatewayConfig, equity: Any, journal: BrokerJournal):
        self.config = config
        self.equity = equity
        self.journal = journal

    def _mark_execution_uncertain(
        self,
        request_id: str,
        *,
        operation: str,
        error: BaseException,
        order_no: Optional[str] = None,
    ) -> None:
        try:
            self.journal.update(
                request_id,
                "EXECUTION_UNCERTAIN",
                order_no=order_no,
                error=_safe_error_name(error),
            )
        except Exception as journal_error:
            raise ExecutionUncertainError(
                f"JOURNAL_UPDATE_FAILED_AFTER_{operation}"
            ) from journal_error

    def account_snapshot(self) -> dict[str, Any]:
        account_info = self.equity.get_account_info()
        portfolios = self._portfolio_items(self.equity.get_portfolios())
        orders = self.equity.get_orders()
        cash_raw = _field(account_info, self.config.cash_field)
        cash = float(cash_raw) if isinstance(cash_raw, (int, float)) and math.isfinite(float(cash_raw)) else None
        return {
            "environment": self.config.environment,
            "accountInfo": {"accountType": str(account_info.get("accountType", ""))},
            "cash": cash,
            "cashVerified": cash is not None,
            "cashField": self.config.cash_field or None,
            "portfolio": [self._normalize_position(item) for item in portfolios],
            "orders": [self._normalize_order(item) for item in orders],
        }

    @staticmethod
    def _portfolio_items(payload: Any) -> list[Mapping[str, Any]]:
        """Normalize both SDK portfolio response shapes without guessing."""
        items = payload.get("portfolioList") if isinstance(payload, Mapping) else payload
        if not isinstance(items, list):
            raise BrokerPolicyError("PORTFOLIO_RESPONSE_UNVERIFIED")
        if not all(isinstance(item, Mapping) for item in items):
            raise BrokerPolicyError("PORTFOLIO_ITEM_UNVERIFIED")
        return items

    def account_schema(self) -> dict[str, Any]:
        schema_allowed = self.config.environment == "uat" or (
            self.config.environment == "prod" and self.config.production_read_only
        )
        if not schema_allowed:
            raise BrokerPolicyError("ACCOUNT_SCHEMA_READ_ONLY_ONLY")
        account_info = self.equity.get_account_info()
        if not isinstance(account_info, Mapping):
            raise BrokerPolicyError("ACCOUNT_INFO_UNVERIFIED")
        fields: list[dict[str, str]] = []

        def visit(value: Any, prefix: str = "", depth: int = 0) -> None:
            if depth > 4 or not isinstance(value, Mapping):
                return
            for raw_key, child in value.items():
                key = str(raw_key)
                compact = re.sub(r"[^a-z0-9]", "", key.casefold())
                if compact in SENSITIVE_SCHEMA_FIELDS:
                    continue
                path = f"{prefix}.{key}" if prefix else key
                if isinstance(child, Mapping):
                    visit(child, path, depth + 1)
                elif isinstance(child, bool):
                    fields.append({"path": path, "type": "boolean"})
                elif isinstance(child, (int, float)):
                    fields.append({"path": path, "type": "number"})
                elif isinstance(child, str):
                    fields.append({"path": path, "type": "string"})
                elif child is None:
                    fields.append({"path": path, "type": "null"})
                elif isinstance(child, list):
                    fields.append({"path": path, "type": "list"})

        visit(account_info)
        return {
            "environment": self.config.environment,
            "fields": sorted(fields, key=lambda item: item["path"]),
        }

    @staticmethod
    def _normalize_position(item: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "sym": str(item.get("symbol", "")).upper(),
            "qty": float(item.get("actualVolume", item.get("currentVolume", item.get("vol", 0))) or 0),
            "avg": float(item.get("averagePrice", 0) or 0),
            "mkt": float(item.get("marketPrice", item.get("lastPrice", 0)) or 0),
        }

    @staticmethod
    def _normalize_order(item: Mapping[str, Any]) -> dict[str, Any]:
        status = str(item.get("status") or item.get("showOrderStatus") or "")[:80]
        raw_reject_code = item.get("rejectCode")
        if isinstance(raw_reject_code, bool):
            reject_code: Any = None
        elif isinstance(raw_reject_code, (int, float)) and math.isfinite(float(raw_reject_code)):
            reject_code = raw_reject_code
        else:
            candidate = str(raw_reject_code or "")[:80]
            reject_code = candidate if re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", candidate) else None
        return {
            "orderNo": str(item.get("orderNo", item.get("orderId", "")) or ""),
            "symbol": str(item.get("symbol", "")).upper(),
            "side": str(item.get("side", "")),
            "price": float(item.get("price", 0) or 0),
            "quantity": float(item.get("vol", item.get("volume", item.get("quantity", 0))) or 0),
            "matchedQuantity": float(item.get("matched", item.get("matchQty", item.get("matchedQuantity", 0))) or 0),
            "cancelled": float(item.get("cancelled", item.get("cancelQty", 0)) or 0),
            "status": status,
            "entryTime": item.get("entryTime", item.get("transactionTime", item.get("tradeTime"))),
            "canCancel": item.get("canCancel") is True,
            "rejectCode": reject_code,
        }

    def list_orders(self) -> list[dict[str, Any]]:
        orders = self.equity.get_orders()
        if not isinstance(orders, list) or not all(isinstance(item, Mapping) for item in orders):
            raise BrokerPolicyError("ORDERS_RESPONSE_UNVERIFIED")
        return [self._normalize_order(item) for item in orders if isinstance(item, Mapping)]

    @staticmethod
    def _normalized_side(value: Any) -> str:
        side = str(value or "").strip().upper()
        if side.startswith("B"):
            return "BUY"
        if side.startswith("S"):
            return "SELL"
        return side

    @staticmethod
    def _is_terminal_order(order: Mapping[str, Any]) -> bool:
        status = str(order.get("status", "")).strip().upper()
        quantity = float(order.get("quantity", 0) or 0)
        matched = float(order.get("matchedQuantity", 0) or 0)
        if quantity > 0 and matched >= quantity:
            return True
        return status in {
            "C", "CX", "CANCELLED", "CANCELED",
            "R", "REJECTED",
            "E", "EXPIRED",
            "M", "MATCHED", "FILLED",
        }

    def _assert_no_open_same_side_order(self, order: Mapping[str, Any]) -> None:
        for broker_order in self.list_orders():
            if self._is_terminal_order(broker_order):
                continue
            if (
                str(broker_order.get("symbol", "")).upper() == order["symbol"]
                and self._normalized_side(broker_order.get("side")) == order["side"]
            ):
                raise BrokerPolicyError("OPEN_ORDER_ALREADY_EXISTS")

    def recovery_candidates(self) -> list[dict[str, Any]]:
        """Find exact broker-order candidates without mutating journal or broker."""
        unresolved = self.journal.list_unresolved()
        broker_orders = self.list_orders()
        output: list[dict[str, Any]] = []
        for operation in unresolved:
            expected = operation.get("order") if isinstance(operation.get("order"), Mapping) else {}
            matches: list[dict[str, Any]] = []
            for broker_order in broker_orders:
                if operation.get("operation") == "PLACE":
                    expected_side = str(expected.get("side", "")).upper()
                    broker_side = str(broker_order.get("side", "")).upper()
                    if broker_side.startswith("B"):
                        broker_side = "BUY"
                    elif broker_side.startswith("S"):
                        broker_side = "SELL"
                    same = (
                        str(broker_order.get("symbol", "")).upper() == str(expected.get("symbol", "")).upper()
                        and broker_side == expected_side
                        and float(broker_order.get("quantity", 0) or 0) == float(expected.get("quantity", 0) or 0)
                        and math.isclose(
                            float(broker_order.get("price", 0) or 0),
                            float(expected.get("price", 0) or 0),
                            rel_tol=0,
                            abs_tol=0.000001,
                        )
                    )
                elif operation.get("operation") == "CANCEL":
                    same = str(broker_order.get("orderNo", "")) == str(expected.get("orderNo", ""))
                else:
                    same = False
                if same:
                    matches.append({
                        "orderNo": str(broker_order.get("orderNo", "")),
                        "status": str(broker_order.get("status", ""))[:80],
                        "entryTime": broker_order.get("entryTime"),
                        "matchedQuantity": float(broker_order.get("matchedQuantity", 0) or 0),
                        "canCancel": broker_order.get("canCancel") is True,
                    })
            count = len(matches)
            output.append({
                "requestId": operation.get("requestId"),
                "operation": operation.get("operation"),
                "status": operation.get("status"),
                "order": expected,
                "matchCount": count,
                "classification": (
                    "NO_CANDIDATE" if count == 0
                    else "EXACTLY_ONE_CANDIDATE" if count == 1
                    else "AMBIGUOUS"
                ),
                "candidates": matches,
            })
        return output

    def get_order(self, order_no: str) -> dict[str, Any]:
        return self._normalize_order(self.equity.get_order(str(order_no)))

    def quote(self, symbol: str) -> dict[str, Any]:
        normalized_symbol = str(symbol).upper().strip()
        if not SYMBOL_RE.fullmatch(normalized_symbol):
            raise BrokerPolicyError("INVALID_SYMBOL")
        raw = self.equity.get_quote_symbol(normalized_symbol)
        if not isinstance(raw, Mapping):
            raise BrokerPolicyError("QUOTE_UNVERIFIED")

        def number(*names: str) -> Optional[float]:
            for name in names:
                value = raw.get(name)
                if isinstance(value, (int, float)) and math.isfinite(float(value)):
                    return float(value)
            return None

        # Explicit allow-list: market data only.  Account/session fields from
        # an SDK response must never cross the local gateway boundary.
        return {
            "symbol": str(raw.get("symbol") or normalized_symbol).upper(),
            "marketStatus": str(raw.get("marketStatus") or "")[:40],
            "status": str(raw.get("status") or "")[:40],
            "last": number("last", "lastPrice"),
            "bid": number("bid", "bestBidPrice"),
            "ask": number("ask", "bestAskPrice"),
            "high": number("high", "highPrice"),
            "low": number("low", "lowPrice"),
            "prior": number("prior", "priorPrice"),
            "ceiling": number("ceiling", "ceilingPrice"),
            "floor": number("floor", "floorPrice"),
            "change": number("change"),
            "pct": number("percentChange", "pct"),
            "volume": number("totalVolume", "volume"),
        }

    def market_snapshot(self, symbol: str) -> dict[str, Any]:
        quote = self.quote(symbol)
        raw = self.equity.get_bid_offer_symbol(quote["symbol"])
        if not isinstance(raw, Mapping):
            raise BrokerPolicyError("BID_OFFER_UNVERIFIED")

        def number(*names: str) -> Optional[float]:
            for name in names:
                value = raw.get(name)
                if (
                    isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and math.isfinite(float(value))
                ):
                    return float(value)
            return None

        raw_symbol = str(raw.get("symbol") or quote["symbol"]).upper().strip()
        if raw_symbol != quote["symbol"]:
            raise BrokerPolicyError("BID_OFFER_SYMBOL_MISMATCH")
        return {
            **quote,
            "bid": number("bid_price1", "bidPrice1"),
            "ask": number("ask_price1", "askPrice1"),
            "bidVolume": number("bid_volume1", "bidVolume1"),
            "askVolume": number("ask_volume1", "askVolume1"),
            "bidFlag": str(raw.get("bid_flag", raw.get("bidFlag", "")))[:20].upper(),
            "askFlag": str(raw.get("ask_flag", raw.get("askFlag", "")))[:20].upper(),
        }

    def place_order(self, request_id: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        request_id = str(request_id).strip()
        if not request_id or len(request_id) > 128:
            raise BrokerPolicyError("INVALID_IDEMPOTENCY_KEY")
        order = self._validate_order(payload)
        fingerprint = _fingerprint(order)
        existing = self.journal.find(request_id)
        if existing:
            if existing["operation"] != "PLACE" or existing["fingerprint"] != fingerprint:
                raise BrokerPolicyError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST")
            if existing["status"] == "SUBMITTED" and existing.get("order_no"):
                return {**_decode_response(existing), "orderNo": existing["order_no"], "duplicate": True}
            raise ExecutionUncertainError(f"ORDER_ALREADY_ATTEMPTED:{existing['status']}")
        self._validate_account_controls(order)
        self._assert_no_open_same_side_order(order)
        existing, created = self.journal.reserve(
            request_id, "PLACE", fingerprint, request=order
        )
        if not created:
            if existing["status"] == "SUBMITTED" and existing.get("order_no"):
                return {**_decode_response(existing), "orderNo": existing["order_no"], "duplicate": True}
            raise ExecutionUncertainError(f"ORDER_ALREADY_ATTEMPTED:{existing['status']}")

        try:
            response = self.equity.place_order(
                pin=self.config.pin,
                side="Buy" if order["side"] == "BUY" else "Sell",
                symbol=order["symbol"],
                volume=order["quantity"],
                price=order["price"],
                qty_open=0,
                trustee_id_type="Local",
                price_type="Limit",
                validity_type="Day",
                # Settrade's FAQ defines True as fail-closed when order
                # screening raises a warning.  Never acknowledge/bypass a
                # broker warning automatically, even in UAT.
                bypass_warning=True,
                valid_till_date="",
            )
            order_no = response.get("orderNo") or response.get("order_no")
            if not order_no:
                raise ExecutionUncertainError("BROKER_RESPONSE_WITHOUT_ORDER_NUMBER")
            output = {**self._normalize_order(response), "orderNo": str(order_no), "duplicate": False}
            self.journal.update(request_id, "SUBMITTED", order_no=str(order_no), response=output)
            return output
        except Exception as error:
            if _is_definite_broker_rejection(error):
                safe_error = _safe_error_name(error)
                self.journal.update(request_id, "REJECTED", error=safe_error)
                raise BrokerPolicyError(f"BROKER_PLACE_REJECTED:{safe_error}") from error
            self._mark_execution_uncertain(
                request_id, operation="PLACE", error=error,
            )
            if isinstance(error, ExecutionUncertainError):
                raise
            raise ExecutionUncertainError(f"BROKER_PLACE_UNCERTAIN:{type(error).__name__}") from error

    def cancel_order(self, request_id: str, order_no: str) -> dict[str, Any]:
        request_id = str(request_id).strip()
        if not request_id or len(request_id) > 128:
            raise BrokerPolicyError("INVALID_IDEMPOTENCY_KEY")
        request = {"orderNo": str(order_no)}
        fingerprint = _fingerprint(request)
        existing = self.journal.find(request_id)
        if existing:
            if existing["operation"] != "CANCEL" or existing["fingerprint"] != fingerprint:
                raise BrokerPolicyError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST")
            if existing["status"] == "SUBMITTED":
                return {**_decode_response(existing), "duplicate": True}
            raise ExecutionUncertainError(f"CANCEL_ALREADY_ATTEMPTED:{existing['status']}")
        before = self.equity.get_order(str(order_no))
        if before.get("canCancel") is not True:
            raise BrokerPolicyError("ORDER_NOT_CANCELLABLE")
        existing, created = self.journal.reserve(
            request_id, "CANCEL", fingerprint, request=request
        )
        if not created:
            if existing["status"] == "SUBMITTED":
                return {**_decode_response(existing), "duplicate": True}
            raise ExecutionUncertainError(f"CANCEL_ALREADY_ATTEMPTED:{existing['status']}")

        try:
            broker_response = self.equity.cancel_order(str(order_no), self.config.pin)
            after = self.equity.get_order(str(order_no))
            status_parts = [str(after.get(key, "")).strip().casefold() for key in (
                "status", "showOrderStatus", "showOrderStatusMeaning", "showStatus", "statusMeaning"
            )]
            # Settrade Equity may return CX for a fully cancelled order.
            # Treat only explicit terminal cancel codes/meanings as cancelled;
            # pending states remain unresolved and fail closed.
            explicit_cancelled = any(
                value in {"c", "cx", "cancelled", "canceled"}
                for value in status_parts
            )
            quantity = float(after.get("vol", after.get("volume", after.get("quantity", 0))) or 0)
            matched = float(after.get("matched", after.get("matchQty", after.get("matchedQuantity", 0))) or 0)
            cancelled = float(after.get("cancelled", after.get("cancelQty", 0)) or 0)
            quantity_accounted = quantity > 0 and matched + cancelled >= quantity
            verified = explicit_cancelled and quantity_accounted and after.get("canCancel") is not True
            if not verified:
                raise ExecutionUncertainError("CANCEL_NOT_CONFIRMED_BY_BROKER")
            output = {
                "orderNo": str(order_no),
                "brokerAccepted": broker_response is not None,
                "order": self._normalize_order(after),
                "cancellationVerified": True,
                "duplicate": False,
            }
            self.journal.update(request_id, "SUBMITTED", order_no=str(order_no), response=output)
            return output
        except Exception as error:
            self._mark_execution_uncertain(
                request_id,
                operation="CANCEL",
                order_no=str(order_no),
                error=error,
            )
            if isinstance(error, ExecutionUncertainError):
                raise
            raise ExecutionUncertainError(f"BROKER_CANCEL_UNCERTAIN:{type(error).__name__}") from error

    def _validate_order(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        symbol = str(payload.get("symbol", payload.get("ticker", ""))).upper().strip()
        side = str(payload.get("side", "")).upper().strip()
        quantity = int(payload.get("quantity", payload.get("volume", 0)) or 0)
        price = float(payload.get("price", 0) or 0)
        price_type = str(payload.get("priceType", "Limit"))
        validity_type = str(payload.get("validityType", "Day"))
        if not SYMBOL_RE.fullmatch(symbol):
            raise BrokerPolicyError("INVALID_SYMBOL")
        if side not in {"BUY", "SELL"}:
            raise BrokerPolicyError("INVALID_SIDE")
        if quantity <= 0 or not math.isfinite(price) or price <= 0:
            raise BrokerPolicyError("INVALID_QUANTITY_OR_PRICE")
        if quantity % self.config.board_lot_for(symbol) != 0:
            raise BrokerPolicyError("BOARD_LOT_REQUIRED")
        if price_type.lower() != "limit" or validity_type.lower() != "day":
            raise BrokerPolicyError("LIMIT_DAY_ONLY")
        if quantity * price > self.config.max_order_value:
            raise BrokerPolicyError("ORDER_VALUE_LIMIT")
        return {"symbol": symbol, "side": side, "quantity": quantity, "price": price}

    def _validate_account_controls(self, order: Mapping[str, Any]) -> None:
        account_info = self.equity.get_account_info()
        if not isinstance(account_info, Mapping):
            raise BrokerPolicyError("ACCOUNT_INFO_UNVERIFIED")

        required_type = self.config.required_account_type.strip().casefold()
        actual_type = str(account_info.get("accountType", "")).strip().casefold()
        if required_type and actual_type != required_type:
            raise BrokerPolicyError("ACCOUNT_TYPE_NOT_ALLOWED")

        if order["side"] == "BUY":
            if not self.config.cash_field:
                raise BrokerPolicyError("CASH_FIELD_NOT_CONFIGURED")
            cash_raw = _field(account_info, self.config.cash_field)
            if not isinstance(cash_raw, (int, float)) or not math.isfinite(float(cash_raw)):
                raise BrokerPolicyError("CASH_UNVERIFIED")
            required_cash = (
                float(order["quantity"]) * float(order["price"])
                * (1 + self.config.cash_buffer_bps / 10000)
            )
            if float(cash_raw) < required_cash:
                raise BrokerPolicyError("INSUFFICIENT_VERIFIED_CASH")
            return

        portfolios = self.equity.get_portfolios()
        available = 0.0
        for item in portfolios if isinstance(portfolios, list) else []:
            if str(item.get("symbol", "")).upper() != order["symbol"]:
                continue
            available += float(item.get("actualVolume", item.get("currentVolume", item.get("vol", 0))) or 0)
        if available < float(order["quantity"]):
            raise BrokerPolicyError("INSUFFICIENT_VERIFIED_POSITION")


def configure_sdk_environment(sdk_config: dict[str, Any], expected: str) -> None:
    """Bind the SDK transport to the gateway's validated environment."""
    if expected not in {"uat", "prod"}:
        raise BrokerPolicyError("SDK_ENVIRONMENT_INVALID")
    sdk_config["environment"] = expected
    if sdk_config.get("environment") != expected:
        raise BrokerPolicyError("SDK_ENVIRONMENT_MISMATCH")


class SdkEquityProxy:
    """Owns one Settrade session and retries one read after a 401 session reset."""

    def __init__(self, config: BrokerGatewayConfig):
        self.config = config
        self._lock = threading.RLock()
        self._investor: Any = None
        self._equity: Any = None
        self._market: Any = None

    def _reset(self) -> None:
        self._investor = None
        self._equity = None
        self._market = None

    def _connect(self) -> Any:
        from requests import request as requests_request
        import settrade_v2.context as sdk_context
        from settrade_v2.config import config as sdk_runtime_config
        from settrade_v2 import Investor

        configure_sdk_environment(sdk_runtime_config, self.config.environment)

        timeout = (self.config.connect_timeout_seconds, self.config.read_timeout_seconds)

        def bounded_request(*args: Any, **kwargs: Any):
            kwargs.setdefault("timeout", timeout)
            return requests_request(*args, **kwargs)

        sdk_context.request = bounded_request
        investor = Investor(
            app_id=self.config.app_id,
            app_secret=self.config.app_secret,
            broker_id=self.config.sdk_broker_id,
            app_code=self.config.app_code,
            is_auto_queue=True,
        )
        self._investor = investor
        self._market = investor.MarketData()
        self._equity = investor.Equity(account_no=self.config.account_no)
        return self._equity

    def _call(self, name: str, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            equity = self._equity or self._connect()
            try:
                return getattr(equity, name)(*args, **kwargs)
            except Exception as error:
                if getattr(error, "status_code", None) != 401:
                    raise
                self._reset()
                if not name.startswith("get_"):
                    # A mutation may have reached the broker before the 401 was
                    # observed. Replaying it could duplicate a real order.
                    raise
                equity = self._connect()
                return getattr(equity, name)(*args, **kwargs)

    def get_quote_symbol(self, symbol: str) -> Any:
        with self._lock:
            if self._equity is None or self._market is None:
                self._connect()
            try:
                return self._market.get_quote_symbol(symbol)
            except Exception as error:
                if getattr(error, "status_code", None) != 401:
                    raise
                # Quotes are read-only, so one retry after session renewal is
                # safe.  Mutations continue to be non-replayable in _call().
                self._reset()
                self._connect()
                return self._market.get_quote_symbol(symbol)

    def get_bid_offer_symbol(self, symbol: str) -> Mapping[str, Any]:
        """Wait for one bid/offer message on the existing authenticated session."""
        with self._lock:
            if self._investor is None or self._equity is None:
                self._connect()
            # Subscriber.stop() disconnects the SDK callbacker. Reusing that
            # RealtimeDataConnection can silently time out on the second
            # preflight, so create a fresh subscriber transport sequentially
            # on the same authenticated Investor context.
            realtime = self._investor.RealtimeDataConnection()

            received = threading.Event()
            holder: dict[str, Any] = {}

            def on_message(message: Any) -> None:
                holder["message"] = message
                received.set()

            subscriber = realtime.subscribe_bid_offer(symbol, on_message)
            try:
                subscriber.start()
                wait_seconds = min(max(self.config.read_timeout_seconds, 1.0), 10.0)
                if not received.wait(wait_seconds):
                    raise BrokerPolicyError("REALTIME_BID_OFFER_TIMEOUT")
            finally:
                subscriber.stop()

            message = holder.get("message")
            if not isinstance(message, Mapping) or message.get("is_success") is not True:
                raise BrokerPolicyError("REALTIME_BID_OFFER_UNVERIFIED")
            data = message.get("data")
            if not isinstance(data, Mapping):
                raise BrokerPolicyError("REALTIME_BID_OFFER_UNVERIFIED")
            return data

    def __getattr__(self, name: str):
        return lambda *args, **kwargs: self._call(name, *args, **kwargs)


class GatewayHandler(BaseHTTPRequestHandler):
    config: BrokerGatewayConfig
    service: BrokerService

    def log_message(self, format: str, *args: Any) -> None:
        # Never log headers, request bodies, credentials, or PINs.
        print(f"[broker-gateway] {self.command} {urlparse(self.path).path} {args[1] if len(args) > 1 else ''}")

    def _authorized(self) -> bool:
        expected = f"Bearer {self.config.gateway_token}"
        return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def _production_confirmed(self) -> bool:
        if self.config.environment != "prod":
            return True
        if self.config.production_read_only or not self.config.production_enabled:
            return False
        return hmac.compare_digest(
            self.headers.get("X-Production-Confirmation", ""),
            self.config.production_confirmation,
        )

    def _json(self, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > 65536:
            raise BrokerPolicyError("INVALID_BODY_SIZE")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _guard(self, mutation: bool = False) -> bool:
        if not self._authorized():
            self._json(401, {"ok": False, "error": "UNAUTHORIZED"})
            return False
        if mutation and not self._production_confirmed():
            error = (
                "PRODUCTION_READ_ONLY"
                if self.config.environment == "prod" and self.config.production_read_only
                else "PRODUCTION_CONFIRMATION_REQUIRED"
            )
            self._json(423, {"ok": False, "error": error})
            return False
        return True

    def do_GET(self) -> None:
        if not self._guard():
            return
        path = urlparse(self.path).path.rstrip("/")
        try:
            if path == "/v1/health":
                unresolved_count = len(self.service.journal.list_unresolved())
                data = {
                    "ready": unresolved_count == 0,
                    "environment": self.config.environment,
                    "sdk": "settrade-v2==2.2.1",
                    "unresolvedOperations": unresolved_count,
                }
            elif path == "/v1/account-schema":
                data = self.service.account_schema()
            elif path == "/v1/account-snapshot":
                data = self.service.account_snapshot()
            elif path == "/v1/orders":
                data = {"environment": self.config.environment, "orders": self.service.list_orders()}
            elif path == "/v1/journal/unresolved":
                data = {
                    "environment": self.config.environment,
                    "operations": self.service.journal.list_unresolved(),
                }
            elif path == "/v1/recovery/candidates":
                data = {
                    "environment": self.config.environment,
                    "operations": self.service.recovery_candidates(),
                }
            elif path.startswith("/v1/quotes/"):
                symbol = path.rsplit("/", 1)[-1]
                data = {"environment": self.config.environment, "quote": self.service.quote(symbol)}
            elif path.startswith("/v1/market-snapshot/"):
                symbol = path.rsplit("/", 1)[-1]
                data = {
                    "environment": self.config.environment,
                    "quote": self.service.market_snapshot(symbol),
                }
            elif path.startswith("/v1/orders/"):
                order_no = path.rsplit("/", 1)[-1]
                data = {"environment": self.config.environment, "order": self.service.get_order(order_no)}
            else:
                self._json(404, {"ok": False, "error": "NOT_FOUND"})
                return
            self._json(200, {"ok": True, "environment": self.config.environment, "data": data})
        except Exception as error:
            self._handle_error(error)

    def do_POST(self) -> None:
        if not self._guard(mutation=True):
            return
        path = urlparse(self.path).path.rstrip("/")
        request_id = self.headers.get("X-Idempotency-Key", "")
        try:
            if path == "/v1/orders":
                data = self.service.place_order(request_id, self._body())
            elif path.startswith("/v1/orders/") and path.endswith("/cancel"):
                order_no = path.split("/")[-2]
                data = self.service.cancel_order(request_id, order_no)
            else:
                self._json(404, {"ok": False, "error": "NOT_FOUND"})
                return
            self._json(200, {"ok": True, "environment": self.config.environment, "data": data})
        except Exception as error:
            self._handle_error(error)

    def _handle_error(self, error: Exception) -> None:
        if isinstance(error, BrokerPolicyError):
            self._json(400, {"ok": False, "environment": self.config.environment, "error": str(error)})
        elif isinstance(error, ExecutionUncertainError):
            self._json(409, {
                "ok": False,
                "environment": self.config.environment,
                "error": str(error),
                "executionUncertain": True,
            })
        else:
            self._json(502, {
                "ok": False,
                "environment": self.config.environment,
                "error": "BROKER_GATEWAY_FAILURE",
            })


class BrokerHTTPServer(HTTPServer):
    # Windows SO_REUSEADDR can allow multiple listeners on one port. A broker
    # gateway must own its local port exclusively or requests can hit different
    # SDK sessions nondeterministically.
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], journal: BrokerJournal, fence: ProcessFence):
        self.journal = journal
        self.fence = fence
        super().__init__(address, GatewayHandler)

    def server_close(self) -> None:
        try:
            super().server_close()
        finally:
            try:
                self.journal.close()
            finally:
                self.fence.close()


def _resolved_journal_path(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate.resolve()
    base = Path(__file__).resolve().parent
    resolved = (base / candidate).resolve()
    try:
        resolved.relative_to(base)
    except ValueError as error:
        raise BrokerPolicyError("JOURNAL_PATH_OUTSIDE_GATEWAY") from error
    return resolved


def build_server(values: Mapping[str, str] = os.environ) -> HTTPServer:
    config = BrokerGatewayConfig.from_mapping(values)
    equity = SdkEquityProxy(config)
    journal_path = _resolved_journal_path(config.journal_path)
    account_key = hashlib.sha256(
        f"{config.environment}:{config.sdk_broker_id}:{config.account_no}".encode("utf-8")
    ).hexdigest()[:16]
    fence = ProcessFence(str(journal_path.with_name(f".broker-gateway-{account_key}.lock")))
    journal: Optional[BrokerJournal] = None
    try:
        journal = BrokerJournal(str(journal_path))
        service = BrokerService(config, equity, journal)
        GatewayHandler.config = config
        GatewayHandler.service = service
        host = str(values.get("BROKER_GATEWAY_HOST", "127.0.0.1"))
        port = int(values.get("BROKER_GATEWAY_PORT", "8787"))
        return BrokerHTTPServer((host, port), journal, fence)
    except Exception:
        if journal is not None:
            journal.close()
        fence.close()
        raise


if __name__ == "__main__":
    default_env = Path(__file__).with_name(".env")
    load_env_file(os.environ.get("BROKER_GATEWAY_ENV_FILE", str(default_env)))
    server = build_server()
    print(f"[broker-gateway] listening on {server.server_address[0]}:{server.server_address[1]}")
    server.serve_forever()
