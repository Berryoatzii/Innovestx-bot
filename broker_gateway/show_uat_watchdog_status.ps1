$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$statusPath = Join-Path $gatewayDir '.uat-watchdog-status.json'

if (-not (Test-Path -LiteralPath $statusPath)) {
  Write-Host 'AEGIS UAT watchdog has not completed a check yet.' -ForegroundColor Yellow
  exit 2
}

$status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "Status: $($status.status)"
Write-Host "Checked (UTC): $($status.checkedAt)"
Write-Host "Positions: $($status.positions) | Orders: $($status.orders) | Unresolved: $($status.unresolved)"
Write-Host 'Order permission: OFF (read-only watchdog)'
