# AEGIS Pre-market Brief — 31 August 2026 (RC2)

Prepared at approximately 07:25 Asia/Bangkok. This brief is advisory and
read-only. It is not an order instruction and contains no account identifier,
PIN, secret, or token.

## Decision

**NO TRADE / RELEASE LOCKED.** The software and broker-read path are ready for
morning observation, but the RC2 strategy is not authorized for live execution.
All 28 real holdings remain `REVIEW`, which is intentionally order-ineligible.
The production lock must remain on.

## System and release evidence

- Audited code-bearing release commit:
  `2b831e388a68abafcaa2ada1657b008e9804262a`; subsequent local changes to this
  brief and the research verdict are documentation-only.
- Remote production commit: `bf67b87cb8effa203bf8c3b64c0be4cb19510bf0`.
- The production branch is an ancestor of the release candidate; the update is
  a 13-commit fast-forward with no history rewrite required.
- Fresh suites after deploy-verifier and shadow-gate hardening: Node
  **215/215 PASS**; Python gateway **118/118 PASS**.
- Production read-only watchdog: **HEALTHY**.
- UAT read-only account check: **PASS**, zero positions, zero orders, zero
  unresolved operations.
- Last sanitized production snapshot before this brief: 28 holdings, cash
  approximately THB 7,316, market value approximately THB 91,782, no open
  orders, and no unresolved operations.
- Account-level Settrade Open API activation: evidenced separately.
- `strategyReleaseApproved=false`, `forwardShadowVerified=false`, and
  `liveTradingEnabled=false`.

## Market regime

- SET closed 28 August at 1,588.22, down 12.48 points (-0.78%), with turnover
  approximately THB 66.47 billion. Foreign investors sold a net THB 1.42
  billion. This supports a defensive rather than chase-the-open posture.
- Nasdaq Composite closed 28 August at 26,402.42, down 0.52%. The prior US
  close does not provide a broad risk-on confirmation.
- The Bank of Thailand held the policy rate at 1.00% on 26 August. It described
  growth as low and uneven, noted continued contraction in SME credit, and
  highlighted Middle East, protectionism, inflation, and baht volatility risks.
- BOT's 28 August USD reference rate was 32.9470 baht per dollar, up from
  32.8240 on 27 August. The weaker baht is relevant to imported costs and
  foreign-underlying DR valuation.
- The Federal Reserve's 29 July target range was 3.50%-3.75%; the next scheduled
  FOMC meeting is 15-16 September. Rate-path uncertainty remains material.
- EIA spot-price data and the August outlook indicate elevated oil/geopolitical
  sensitivity. Exact tradable oil and gold quotes must be refreshed after the
  relevant markets are live; no stale weekend value can authorize an order.

## Portfolio risk and classification

Cash is approximately 7.4% of cash plus market value versus the 20% policy
target, leaving an estimated reserve shortfall of about THB 12,500. The first
portfolio objective is therefore to rebuild liquidity selectively, not force a
new purchase.

| Disposition | Symbols | Pre-market action |
|---|---|---|
| CORE candidates pending full thesis cards | AIT, DRT, KGI, MFC, PM, RATCH, RJH, SAT, SMPC, TACC, TCAP, TIPH, TKS, TSC | Hold for review; no automatic buy or sell |
| ACTIVE watch pending live liquidity/trigger | ASEFA, GC, SNC, TSC, WINNER | Observe only; Signal A and all gates required |
| REDUCE review | ARROW, ICN, IFS, LALIN, LH, MBAX, PDG, PTL, TPIPP | Refresh thesis and use staged resting limits only if later authorized |
| EXIT review priority | TMILL | Qualified auditor opinion requires priority review; no panic or market-order exit |

These are research dispositions, not executable classifications. The checked-in
policy correctly keeps every symbol in `REVIEW` until a complete, sourced thesis
card is approved.

## RC2 research candidate

- Candidate: `AEGIS-DR-ROTATION-RC2-2026-08-31`.
- Universe: SP50001, NDX01, INDIA01, CN01, BONDUS01, GOLDUS03.
- Maximum three positions, 5% each, 15% gross; long-only Cash Balance.
- Quarterly rebalance with a retention buffer; Resting Limit orders only.
- Final holdout passed all frozen cost cases, but historical results do not
  guarantee future performance and do not grant order authority.

## Intraday control plan

1. Before 09:20, refresh production read-only health, cash, holdings, orders,
   unresolved journal, SET/company disclosures, macro inputs, and prior US close.
2. From 09:30 through the random T1 open (09:55-10:00), observe only. Do not use
   Market, ATO, or ATC orders.
3. Wait at least 15 minutes after T1 (approximately 10:10-10:15) before treating
   bid, ask, spread, and volume as decision inputs.
4. Produce a proposal only when the symbol is no longer `REVIEW`, the strategy
   and shadow gates pass, market data are current, R:R after costs is at least
   2.0, and the user approves the exact order.
5. If any gate is missing, stale, or conflicting, remain **NO TRADE**.

## Remaining release sequence

1. Receive explicit user authorization to fast-forward/deploy RC2 while keeping
   live trading off.
2. Send the exact RC2 strategy/logic/parameter approval request from the user's
   registered personal email only after action-time confirmation.
3. Verify the deployed commit and `liveTradingEnabled=false`.
   Use `tools/verify-rc2-deployment.js` and require all checks to pass; the exact
   procedure is in `docs/AEGIS_RC2_DEPLOY_RUNBOOK.md`.
4. Start append-only forward-shadow collection. A minimum of 20 real SET trading
   days, 120 instrument decisions (six instruments on every clean day), one
   rebalance event, and zero integrity/data errors is mandatory; no backfill or
   synthetic day is permitted.
5. Reassess member approval, compatibility, shadow evidence, current quotes,
   cash reserve, and the exact per-order approval before any pilot.

## Official sources

- SET market overview: https://www.set.or.th/en/home
- SET trading hours: https://www.set.or.th/th/market/information/trading-procedure/trading-hours
- SET TMILL factsheet: https://www.set.or.th/en/market/product/stock/quote/TMILL/factsheet
- BOT MPC decision: https://www.bot.or.th/en/news-and-media/news/mpc/news-20260826-KsecaE98.html
- BOT daily FX statistics: https://app.bot.or.th/BTWS_STAT/statistics/BOTWEBSTAT.aspx?reportID=123
- Federal Reserve statement: https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm
- Federal Reserve calendar: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
- Nasdaq Composite: https://indexes.nasdaq.com/Index/Overview/COMP
- EIA spot prices: https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm
- LBMA gold-price benchmark information: https://www.lbma.org.uk/prices-and-data/lbma-gold-price
