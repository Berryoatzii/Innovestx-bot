$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:BROKER_GATEWAY_ENV_FILE = Join-Path $gatewayDir '.env.production-readonly'
& (Join-Path $gatewayDir '.venv\Scripts\python.exe') `
  (Join-Path $gatewayDir 'production_readonly_watchdog.py')
exit $LASTEXITCODE
