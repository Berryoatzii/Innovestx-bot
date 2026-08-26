# Human Approval Trading — Deployment Runbook

## Operating model

`Shadow analysis -> expiring order intent -> Telegram approval -> broker/risk preflight -> signed Limit order -> reconciliation`

The LLM is advisory only. It cannot authorize quantity, bypass risk limits, or call the broker directly.

## Mandatory safe defaults

Set these values first:

```text
SCHEDULED_TRADE_MODE=dry_run
LIVE_TRADING_ENABLED=false
HUMAN_APPROVAL_LIVE_ENABLED=false
HUMAN_APPROVAL_ONLY=true
TELEGRAM_PROGRESS_ENABLED=true
```

With either live flag set to `false`, pressing Approve records the attempt but sends no broker order.

## Required secrets

Never commit these values:

```text
ADMIN_TOKEN
EXECUTE_CONFIRMATION
ORDER_INTENT_GATE_SECRET
BROKER_GATEWAY_URL
BROKER_GATEWAY_TOKEN
BROKER_GATEWAY_ENVIRONMENT
TELEGRAM_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_APPROVER_USER_ID
TELEGRAM_WEBHOOK_SECRET
```

Use independent random values for `ADMIN_TOKEN`, `EXECUTE_CONFIRMATION`, `ORDER_INTENT_GATE_SECRET`, and `TELEGRAM_WEBHOOK_SECRET`.

Broker credentials (`SETTRADE_APP_ID`, `SETTRADE_APP_SECRET`,
`SETTRADE_ACCOUNT_NO`, `SETTRADE_PIN`) belong only in the private worker's
`broker_gateway/.env`; never place them in Netlify or a browser.

## Proposal controls

```text
PROPOSAL_MAX_POSITION_FRACTION=0.25
PROPOSAL_MAX_ORDER_VALUE=3000
PROPOSAL_BOARD_LOT=100
ORDER_INTENT_TTL_MINUTES=45
CORE_SYMBOLS=SYMBOL1,SYMBOL2
```

- CORE symbols do not receive sell approval buttons from the hourly shadow process.
- A proposal is skipped if it would sell the full position.
- Expired proposals cannot be approved.

## Live pilot controls

Keep these at zero until shadow validation is accepted:

```text
MAX_LIVE_ORDER_VALUE=0
MAX_DAILY_APPROVED_NOTIONAL=0
MAX_DAILY_APPROVED_ORDERS=1
OPERATIONAL_PILOT_MODE=false
MAX_LIVE_POSITION_FRACTION=0.25
MAX_PRICE_DRIFT_PCT=0.02
MAX_SPREAD_PCT=0.03
```

Before the one-order operational pilot, every operational release gate must pass.
For the recommended outbound-worker topology also configure matching values on the
control plane and private machine:

```text
EXECUTION_TOPOLOGY=PRIVATE_WORKER_QUEUE
PRIVATE_WORKER_TOKEN=<independent random machine token>
ORDER_INTENT_GATE_SECRET=<same HMAC secret on control plane and worker>
AUDITED_COMMIT_REF=<exact commit reviewed for this release>
```

The broker API secret, account and PIN remain only on the private machine. The
control plane never receives them and never tries to reach a loopback URL.
Netlify supplies `COMMIT_REF` automatically. The release gate compares it with
`AUDITED_COMMIT_REF`; do not try to embed a commit's own hash into that same commit.
Set `OPERATIONAL_PILOT_MODE=true`, keep `MAX_DAILY_APPROVED_ORDERS=1`, set small
positive values for the two zero limits, then enable both:

```text
LIVE_TRADING_ENABLED=true
HUMAN_APPROVAL_LIVE_ENABLED=true
```

Do not enable only one flag and assume the system is live; both are required.
The operational-pilot lock is written with strong consistency before the broker
request. After the first attempt it cannot reset itself, even if the response is
rejected or uncertain. Continuous live use requires full strategy release evidence
and `OPERATIONAL_PILOT_MODE=false`.

## Telegram webhook setup

After the production deploy:

1. Send a POST request to `/.netlify/functions/telegram?action=setWebhook`.
2. Include `x-admin-token: <ADMIN_TOKEN>`.
3. The function registers the webhook with `TELEGRAM_WEBHOOK_SECRET` and restricts updates to messages and callback queries.
4. Run `/.netlify/functions/telegram?action=test` with the same admin header.
5. In Telegram, run `/status` and confirm that the configured chat and approver user are the intended owner.

## What happens after Approve

The approval executor checks all of the following again:

- intent exists, is pending, and has not expired
- the approver user and chat are authorized
- live flags and all required secrets are configured
- Thai market is in a continuous trading session, not auction or lunch
- position still exists and proposal is not a full exit
- proposal is within position fraction and order-value limits
- no duplicate open order exists for the same symbol and side
- authenticated quote has valid bid/ask and acceptable spread
- current executable price has not drifted too far from the proposal
- daily order count and daily notional limits are not exceeded

Only then is a signed Limit order sent. The system never submits a market/ATO order from this flow.

## Reconciliation

`reconcile-orders` runs every 10 minutes during Thai market hours and updates:

- ACKNOWLEDGED
- PARTIALLY_FILLED
- FILLED
- CANCELLED
- REJECTED_BY_BROKER
- EXECUTION_UNCERTAIN

If an order cannot be proven accepted or rejected, the system marks it uncertain and never retries automatically.

## Go / No-Go

Live pilot remains NO-GO until:

- GitHub safety tests pass
- production deploy uses this branch/merge commit
- Telegram webhook secret, chat ID, and approver user ID are verified
- at least 20 trading days of shadow records are reviewed
- zero duplicate intents and zero unauthorized execution attempts
- CORE/ACTIVE classification has been completed
- small live risk limits are explicitly approved by the owner
