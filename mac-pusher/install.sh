#!/usr/bin/env bash
# install.sh — installs a launchd agent (Mac-native cron equivalent) that
# runs push-usage.sh every 5 minutes while you're logged in.
#
# Usage:
#   CLAUDE_WIDGET_URL=https://your-app.vercel.app \
#   CLAUDE_WIDGET_TOKEN=your-secret-token \
#   bash install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-usage.sh"

API_URL="${CLAUDE_WIDGET_URL:-}"
API_TOKEN="${CLAUDE_WIDGET_TOKEN:-}"

if [[ -z "$API_URL" || -z "$API_TOKEN" ]]; then
  echo "❌  Set CLAUDE_WIDGET_URL and CLAUDE_WIDGET_TOKEN before running."
  exit 1
fi

chmod +x "$PUSH_SCRIPT"

PLIST_LABEL="com.claudewidget.pusher"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PUSH_SCRIPT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_WIDGET_URL</key>   <string>${API_URL}</string>
    <key>CLAUDE_WIDGET_TOKEN</key> <string>${API_TOKEN}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>   <integer>300</integer>
  <key>RunAtLoad</key>       <true/>
  <key>StandardOutPath</key> <string>/tmp/claude-widget.log</string>
  <key>StandardErrorPath</key><string>/tmp/claude-widget-err.log</string>
</dict>
</plist>
PLIST

# Unload any existing agent before reloading
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo "✅  LaunchAgent installed: runs every 5 minutes."
echo "    Logs: /tmp/claude-widget.log"
echo "    To uninstall: launchctl unload $PLIST_PATH && rm $PLIST_PATH"
