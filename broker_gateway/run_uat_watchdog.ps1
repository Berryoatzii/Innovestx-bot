$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'
$watchdogScript = Join-Path $gatewayDir 'uat_watchdog.py'

if (-not (Test-Path -LiteralPath $pythonExe)) {
  throw 'UAT Gateway is not installed.'
}
if (-not (Test-Path -LiteralPath $envPath)) {
  throw 'UAT configuration is missing.'
}

$env:BROKER_GATEWAY_ENV_FILE = $envPath
& $pythonExe $watchdogScript
exit $LASTEXITCODE
