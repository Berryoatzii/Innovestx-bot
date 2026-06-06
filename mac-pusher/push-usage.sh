#!/usr/bin/env bash
# push-usage.sh — reads Claude Code usage from the local session file and
# pushes it to the Vercel API endpoint so widgets stay up to date.
#
# Required env vars (add to ~/.zshrc or ~/.bash_profile):
#   CLAUDE_WIDGET_URL   e.g. https://your-app.vercel.app
#   CLAUDE_WIDGET_TOKEN  same value as API_TOKEN in Vercel env vars

set -euo pipefail

API_URL="${CLAUDE_WIDGET_URL:-}"
API_TOKEN="${CLAUDE_WIDGET_TOKEN:-}"

if [[ -z "$API_URL" || -z "$API_TOKEN" ]]; then
  echo "❌  Set CLAUDE_WIDGET_URL and CLAUDE_WIDGET_TOKEN first." >&2
  exit 1
fi

# ── Find Claude usage data ────────────────────────────────────────────────────
# Claude Code stores per-session rate-limit data in ~/.claude/
# Try multiple known locations across CLI versions.

USAGE_JSON=""

# 1. Prefer `claude usage --json` if the flag exists (v2.1.80+)
if command -v claude &>/dev/null; then
  USAGE_JSON=$(claude usage --json 2>/dev/null || true)
fi

# 2. Fallback: read the raw usage file Claude Code writes locally
if [[ -z "$USAGE_JSON" ]]; then
  for candidate in \
    "$HOME/.claude/usage.json" \
    "$HOME/.claude/session.json" \
    "$HOME/.claude/rate_limits.json"
  do
    if [[ -f "$candidate" ]]; then
      USAGE_JSON=$(cat "$candidate")
      break
    fi
  done
fi

if [[ -z "$USAGE_JSON" ]]; then
  echo "⚠️  No Claude usage data found — Claude Code may not be running." >&2
  exit 0
fi

# ── Parse percentages with Node.js ───────────────────────────────────────────
PAYLOAD=$(node - "$USAGE_JSON" <<'NODE'
const raw = process.argv[1];
let usage;
try { usage = JSON.parse(raw); } catch { process.exit(1); }

function fmtReset(msFromNow) {
  if (!msFromNow || msFromNow <= 0) return '';
  const totalMin = Math.round(msFromNow / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function pct(used, limit) {
  if (!limit) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

let sessionPct = 0, weeklyPct = 0, sessionResets = '', weeklyResets = '';

// Format A: { rate_limits: [ { window, used, limit, resetAt } ] }
const limits = usage.rate_limits || usage.rateLimits || [];
for (const l of limits) {
  const win = (l.window || l.type || '').toLowerCase();
  const p   = pct(l.used ?? l.tokensUsed, l.limit ?? l.tokenLimit);
  const r   = fmtReset(l.resetAt ? new Date(l.resetAt) - Date.now() : 0);
  if (win.includes('5h') || win.includes('session') || win.includes('hourly')) {
    sessionPct = p; sessionResets = r;
  }
  if (win.includes('7d') || win.includes('week')) {
    weeklyPct = p; weeklyResets = r;
  }
}

// Format B: flat { session_pct, weekly_pct } (already computed)
if (!sessionPct && usage.session_pct != null) sessionPct = Math.round(usage.session_pct);
if (!weeklyPct  && usage.weekly_pct  != null) weeklyPct  = Math.round(usage.weekly_pct);

// Format C: { session: { percent, resetsIn }, weekly: { percent, resetsIn } }
if (!sessionPct && usage.session?.percent != null) {
  sessionPct    = Math.round(usage.session.percent);
  sessionResets = usage.session.resetsIn || '';
}
if (!weeklyPct && usage.weekly?.percent != null) {
  weeklyPct    = Math.round(usage.weekly.percent);
  weeklyResets = usage.weekly.resetsIn || '';
}

process.stdout.write(
  JSON.stringify({ sessionPct, weeklyPct, sessionResets, weeklyResets })
);
NODE
)

if [[ -z "$PAYLOAD" ]]; then
  echo "⚠️  Could not parse usage data." >&2
  exit 0
fi

# ── Push to Vercel API ────────────────────────────────────────────────────────
RESPONSE=$(curl -sf -X POST "${API_URL}/api/usage" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1) || {
    echo "❌  Failed to reach ${API_URL}/api/usage" >&2
    exit 1
  }

echo "✅  Pushed: $PAYLOAD"
echo "    Response: $RESPONSE"
