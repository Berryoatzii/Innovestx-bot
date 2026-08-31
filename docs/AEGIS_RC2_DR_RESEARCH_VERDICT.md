# AEGIS RC2 DR Research Verdict

Freeze date: 2026-08-31

Status: **FINAL HOLDOUT PASS / release remains locked**

This evidence is research-only. It used public market history through local tooling and did not contact INVX, Settrade order endpoints, Telegram, Netlify Blobs, or any money-moving path. Production remains locked.

## Method

- Universe: six Thai-listed DR research proxies mapped to SPY, QQQ, INDA, ASHR, AGG, and GLD.
- Maximum exposure: three positions at 5% each (15% gross).
- Benchmark gross exposure is also 15%.
- Stress costs: 0.268%, 0.5%, and 1.0% per unit of turnover.
- Development data ends 2024-07; the final 24-month holdout beginning 2024-08 remained unopened.
- Eight development variants covered 6- and 12-month momentum, monthly/quarterly/semiannual cadence, and two predeclared no-trade buffers.

## Verdict

`AEGIS-DR-ROTATION-RC2-2026-08-31` passed every full-sample and inner-holdout development gate after the eligibility-buffer bug was fixed and regression-tested. At the severe 1% turnover-cost stress, full-sample excess was +0.14%, inner-holdout excess was +1.52%, full-sample maximum drawdown was -2.54%, and inner-holdout maximum drawdown was -0.95%.

The exact universe, implementation hashes and parameters are recorded in `config/dr-strategy-research-candidate-rc2.json`. The one-time final holdout from 2024-08 through the last completed month, 2026-07, passed all three friction scenarios: after-cost return +4.34% to +4.66%, benchmark excess +0.35% to +0.51%, and maximum drawdown about -0.95%. Durable evidence is in `config/dr-strategy-final-holdout-rc2.json`.

Passing the final holdout does not authorize an order. Member approval for this exact RC2 strategy, forward shadow evidence, current DR quote/liquidity checks, and per-order human approval remain mandatory.

## Verification

- Fresh pre-market verification on 2026-08-31 at approximately 07:23 Asia/Bangkok:
  The original audited code baseline passed Node 210/210 and Python gateway
  118/118. After adding the fail-closed deploy verifier and strengthening the
  forward-shadow threshold/integrity recheck, the full suites pass
  **Node 215/215** and **Python gateway 121/121**. The additional Python tests
  cover the sanitized GET-only client probe for an already-running production
  gateway.
- The production read-only watchdog returned **HEALTHY** and the UAT read-only
  check returned **PASS** after the fresh test run. Neither check submitted,
  changed, or cancelled an order.
- `strategyReleaseApproved` remains `false`.
- `forwardShadowVerified` remains `false` until the append-only collector has
  accumulated the required real SET trading-day evidence.
- `liveTradingEnabled` remains `false`.
