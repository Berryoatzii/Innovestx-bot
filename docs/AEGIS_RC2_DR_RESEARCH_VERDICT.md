# AEGIS RC2 DR Research Verdict

Freeze date: 2026-08-31

Status: **HOLD / one development candidate frozen; final holdout unopened**

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

The exact universe, implementation hashes, parameters and unopened holdout boundary are recorded in `config/dr-strategy-research-candidate-rc2.json`. This candidate is not eligible for member submission, shadow promotion, or production execution unless the one-time final holdout also passes.

## Verification

- Node suite after freezing: **193/193 passed**.
- `strategyReleaseApproved` remains `false`.
- `liveTradingEnabled` remains `false`.
