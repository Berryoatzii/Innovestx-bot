# Trading System Contract v0

## Status

- Live execution: **DISABLED**
- LLM execution authority: **PROHIBITED**
- Missing or conflicting evidence: **NO TRADE**

This document is the controlling design contract for the trading system. Code, prompts, dashboards and schedules must conform to this contract.

## Core principle

The system must be explainable and reproducible without an LLM.

An LLM may:
- summarize evidence;
- explain deterministic rule outcomes;
- flag anomalies for human review;
- draft operator messages.

An LLM may not:
- invent a fundamental, momentum, growth or risk score from insufficient data;
- authorize an order;
- choose order size;
- override portfolio limits;
- bypass stale or missing data;
- convert a recommendation directly into execution.

## Target architecture

```text
Market/Broker/Data adapters
        ↓
Schema + freshness + provenance gate
        ↓
Feature engine
        ↓
Deterministic strategy engine
        ↓
Portfolio policy + risk engine
        ↓
Order intent ledger (idempotent)
        ↓
Human approval gate
        ↓
Broker execution adapter
        ↓
Order/fill reconciliation
        ↓
Immutable audit log + alerts

LLM explanation service runs beside the pipeline and has no execution permission.
```

## Portfolio policy

Every position must belong to exactly one bucket:

- `CORE`: long-horizon wealth allocation; protected from intraday AI sell signals.
- `ACTIVE`: rules-based tactical allocation.
- `REVIEW`: classification or evidence incomplete; no new exposure.
- `EXIT_PLAN`: controlled reduction only under an approved exit schedule.

The requested strategic target is 60% `CORE` and 40% `ACTIVE`, but the system must not rebalance automatically until the policy parameters, costs and tax effects are approved and tested.

## Data contract

Every material input must include:

- source;
- symbol and market;
- observed timestamp;
- received timestamp;
- freshness limit;
- schema version;
- validation status;
- confidence or quality flag where applicable.

Reject the decision when:

- price is zero, negative, NaN or outside an allowed range;
- bid/ask is crossed or absent when required;
- data exceeds freshness SLA;
- symbol mapping is ambiguous;
- market status is unknown;
- required corporate-action/status data is unavailable;
- sources materially conflict.

## Strategy contract

A strategy must be a versioned, testable specification with:

- eligible universe;
- timeframe;
- entry rules;
- exit rules;
- stop/thesis-break rules;
- position-sizing rule;
- portfolio constraints;
- transaction-cost model;
- data requirements;
- exception behavior;
- benchmark;
- retirement criteria.

Prompt text is not a strategy specification.

## Risk contract

Live order eligibility requires all limits to be explicitly configured and non-zero where appropriate:

- maximum order value;
- maximum position weight;
- maximum active allocation;
- minimum cash reserve;
- maximum daily turnover;
- maximum daily realized loss;
- maximum portfolio drawdown;
- maximum open orders;
- maximum orders per symbol per day;
- maximum slippage;
- maximum data age;
- cooldown after an error or rejected order.

Undefined risk limits mean `NO TRADE`.

## Order-intent contract

Every order intent must include:

- unique idempotency key;
- run ID;
- strategy version;
- policy version;
- symbol, side, quantity and limit price;
- evidence timestamps;
- rule reason codes;
- pre-trade portfolio snapshot hash;
- operator approval identity and time;
- expiry time;
- current lifecycle state.

Lifecycle states:

```text
PROPOSED → VALIDATED → APPROVED → SUBMITTED → ACKNOWLEDGED
→ PARTIALLY_FILLED → FILLED
or REJECTED / CANCELLED / EXPIRED / RECONCILIATION_ERROR
```

No second order may be submitted for the same idempotency key.

## Broker execution contract

Before submitting an order:

1. Fetch a fresh authenticated broker quote.
2. Revalidate position, cash and open orders.
3. Validate market session, auction state, tick size, board lot and price limits.
4. Validate symbol status and corporate actions.
5. Re-run portfolio and risk checks.
6. Persist the intent before calling the broker.

After submission:

1. Store broker acknowledgement and order ID.
2. Poll/reconcile until terminal state.
3. Handle partial fills explicitly.
4. Freeze new orders on reconciliation mismatch.
5. Alert the operator with a traceable run ID.

## Validation gates

### Gate A — Data readiness
- Required fields complete and schema-valid.
- Source timestamps within SLA.
- No impossible values.
- Provenance stored.

### Gate B — Research readiness
- Rules-only baseline implemented.
- Backtest and walk-forward evaluation completed.
- Out-of-sample results include realistic fees, slippage and taxes.
- Compared with relevant total-return benchmark and cash.
- Metrics include return, volatility, drawdown, turnover, hit rate, payoff ratio and tail loss.

### Gate C — Shadow readiness
- At least 20 trading days and 100 decision events.
- Zero duplicate intents.
- Zero unauthorized execution attempts.
- Every recommendation reproducible from stored evidence.
- Reconciliation simulation passes.

### Gate D — Limited-live readiness
- Manual approval only.
- One small order at a time.
- Hard loss/drawdown circuit breakers enabled.
- Automatic rollback to shadow mode on any critical error.
- Independent review completed.

## Security contract

- Secrets are server-side only and must be rotated periodically.
- Static tokens must support rotation and replay protection.
- Sensitive endpoints require authentication, authorization and rate limiting.
- Third-party API responses are untrusted input and require validation, timeouts and size limits.
- Maintain an inventory of all public endpoints and deployed versions.
- No account identifiers or secrets in source, logs, screenshots, handoff documents or client storage.

## Observability contract

Every run must emit:

- run ID;
- deployment version;
- mode;
- source freshness summary;
- decision count by outcome;
- risk-gate result;
- order-intent count;
- execution/reconciliation result;
- error severity;
- rollback/kill-switch state.

Alerts must distinguish:

- informational shadow signal;
- action required;
- execution submitted;
- execution failed;
- reconciliation mismatch;
- live trading locked.

## Go / No-Go rule

The system remains `NO-GO` for live execution until all P0 audit findings are closed and Gates A-C pass with documented evidence. A successful CI run alone is not evidence that the investment strategy is profitable or execution-safe.
