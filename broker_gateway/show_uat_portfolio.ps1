$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'

if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'Run setup_uat.ps1 first.' }
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Run setup_uat.ps1 first.' }

$env:BROKER_GATEWAY_ENV_FILE = $envPath
& $pythonExe (Join-Path $gatewayDir 'show_uat_portfolio.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Read-Host 'Press Enter to close'
