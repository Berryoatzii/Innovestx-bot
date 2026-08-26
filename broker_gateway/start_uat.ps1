$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'

if (-not (Test-Path -LiteralPath $pythonExe)) {
  throw 'Gateway is not installed. Run setup_uat.ps1 first.'
}
if (-not (Test-Path -LiteralPath $envPath)) {
  throw 'UAT configuration is missing. Run setup_uat.ps1 first.'
}

$env:BROKER_GATEWAY_ENV_FILE = $envPath
Set-Location -LiteralPath $gatewayDir
Write-Host 'Starting Broker Gateway in UAT/Sandbox mode only...' -ForegroundColor Yellow
& $pythonExe (Join-Path $gatewayDir 'gateway.py')
