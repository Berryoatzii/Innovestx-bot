# AEGIS RC2 Safe Deploy Runbook

This runbook deploys the research/forward-shadow release while keeping every
money-moving path locked. It must not be run until the user explicitly approves
the GitHub push and Netlify production deploy.

## Preconditions

- Worktree is clean.
- `origin/claude/ai-agent-deployment-game-vpLlI` is an ancestor of `HEAD`.
- Full Node and Python gateway suites pass.
- `LIVE_TRADING_ENABLED` remains absent or `false`.
- No broker credential is stored in Netlify.
- No order, change, cancel, PIN, or broker write probe is part of this runbook.

## Publish without rewriting history

From the release worktree, after action-time approval:

```powershell
git fetch origin --prune
git merge-base --is-ancestor origin/claude/ai-agent-deployment-game-vpLlI HEAD
git push origin codex/readiness-safe-http
git push origin HEAD:refs/heads/claude/ai-agent-deployment-game-vpLlI
```

Do not use `--force` or `--force-with-lease`. If the ancestry check or either
push fails, stop and fetch/review the new remote state. Do not replace remote
history.

## Mandatory post-deploy proof

Wait until Netlify reports the expected commit as the published deploy, then run:

```powershell
$expectedCommit = git rev-parse HEAD
node tools/verify-rc2-deployment.js --expected-commit $expectedCommit
```

The verifier performs exactly three unauthenticated HTTPS GET requests:

1. Public Netlify site metadata.
2. Telegram health.
3. Forward-shadow endpoint without an admin credential.

It passes only when:

- published commit and production branch match exactly;
- Netlify deploy state is `ready`;
- app version is `9.0.0-rc2-forward-shadow`;
- `liveTradingEnabled=false`; and
- the public forward-shadow endpoint returns `401`, proving the route exists but
  is not publicly readable.

The verifier never sends an Authorization header, never contacts INVX or the
broker gateway, never calls an order endpoint, and never moves money.

## Failure handling

- Any failed check means **release locked / no trade**.
- Do not turn on live trading to diagnose a failure.
- Do not retry a broker write, create a test order, or use TTB 100 shares.
- Preserve the failed verifier output as sanitized evidence.
- A rollback or replacement deploy is a separate external action and requires
  explicit user authorization after the exact target is identified.

## Forward-shadow start

The scheduled collector runs at 08:45 Asia/Bangkok on SET weekdays. A successful
deploy does not make `forwardShadowVerified=true`. The gate requires at least 20
real SET trading days, the required decision/rebalance evidence, a valid hash
chain, and zero data/broker/order/money-moving violations. Backfill and synthetic
trading days are forbidden.
