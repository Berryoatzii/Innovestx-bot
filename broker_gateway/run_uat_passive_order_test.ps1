$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'

& (Join-Path $gatewayDir 'check_uat.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Read-only UAT check must pass first.' }

Write-Host ''
Write-Host 'UAT/Sandbox only: place one deeply passive BUY and cancel it.' -ForegroundColor Yellow
$symbol = (Read-Host 'Symbol (recommended PTT)').Trim().ToUpperInvariant()
if (-not $symbol) { $symbol = 'PTT' }

Write-Host 'Realtime bid/ask, volume, tick, board lot and floor (when available) are verified twice.' -ForegroundColor Cyan
$confirmation = Read-Host 'Type SEND_UAT_ORDER_ONLY to confirm'
if ($confirmation -cne 'SEND_UAT_ORDER_ONLY') {
  throw 'Cancelled: exact UAT confirmation was not entered.'
}

$env:BROKER_GATEWAY_ENV_FILE = $envPath
& $pythonExe (Join-Path $gatewayDir 'uat_order_cycle.py') `
  --passive-buy --symbol $symbol --confirm $confirmation
if ($LASTEXITCODE -ne 0) {
  throw "Passive UAT lifecycle test is incomplete (exit $LASTEXITCODE)."
}
