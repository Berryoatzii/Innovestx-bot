$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'

& (Join-Path $gatewayDir 'check_uat.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Read-only UAT check must pass first.' }

$symbol = if ($args.Count -gt 0) { [string]$args[0] } else { 'PTT' }
$symbol = $symbol.Trim().ToUpperInvariant()
if (-not $symbol) { $symbol = 'PTT' }

$env:BROKER_GATEWAY_ENV_FILE = $envPath
& $pythonExe (Join-Path $gatewayDir 'uat_order_cycle.py') `
  --plan-only --symbol $symbol
if ($LASTEXITCODE -ne 0) {
  throw "Read-only UAT order plan failed (exit $LASTEXITCODE)."
}

Write-Host 'PLAN ONLY: no POST, no order, no real money.' -ForegroundColor Green
