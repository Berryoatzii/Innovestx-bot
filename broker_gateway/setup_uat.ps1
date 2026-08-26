$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvDir = Join-Path $gatewayDir '.venv'
$pythonExe = Join-Path $venvDir 'Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'
$sdkConfigPath = Join-Path $env:USERPROFILE 'AppData\settradesdkv2_config.txt'

if (-not (Test-Path -LiteralPath $pythonExe)) {
  $launcher = Get-Command py -ErrorAction SilentlyContinue
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  $codexPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
  if ($launcher) {
    & $launcher.Source -3 -m venv $venvDir
  } elseif ($pythonCommand) {
    & $pythonCommand.Source -m venv $venvDir
  } elseif (Test-Path -LiteralPath $codexPython) {
    & $codexPython -m venv $venvDir
  } else {
    throw 'Python 3 was not found. Install Python 3 or open this project in Codex first.'
  }
  if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment setup failed.' }
}
& $pythonExe -m pip install --disable-pip-version-check -r (Join-Path $gatewayDir 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Settrade SDK installation failed.' }

# Settrade SDK defaults to production when this file is absent. UAT setup must
# write the official SDK selector before the first SDK import.
$sdkConfig = @('environment=uat', 'clear_log=30', 'param=')
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllLines($sdkConfigPath, $sdkConfig, $utf8NoBom)

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$appId = Read-Host 'Settrade UAT App ID'
$appSecret = Read-PlainSecret 'Settrade UAT App Secret'
$appCode = Read-Host 'Settrade Sandbox App Code (press Enter for SANDBOX)'
if ([string]::IsNullOrWhiteSpace($appCode)) { $appCode = 'SANDBOX' }
$accountNo = Read-Host 'UAT account number'
$pin = Read-PlainSecret 'UAT account PIN'
$tokenBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
$gatewayToken = ([BitConverter]::ToString($tokenBytes) -replace '-', '').ToLowerInvariant()

$lines = @(
  'BROKER_ENVIRONMENT=uat'
  "SETTRADE_APP_ID=$appId"
  "SETTRADE_APP_SECRET=$appSecret"
  "SETTRADE_APP_CODE=$appCode"
  "SETTRADE_ACCOUNT_NO=$accountNo"
  "SETTRADE_PIN=$pin"
  "BROKER_GATEWAY_TOKEN=$gatewayToken"
  'BROKER_GATEWAY_HOST=127.0.0.1'
  'BROKER_GATEWAY_PORT=8787'
  'BROKER_JOURNAL_PATH=broker-journal.sqlite3'
  'BROKER_MAX_ORDER_VALUE=3000'
  'BROKER_CASH_FIELD='
  'BROKER_REQUIRED_ACCOUNT_TYPE='
  'BROKER_BOARD_LOT=100'
  'BROKER_CASH_BUFFER_BPS=100'
  'BROKER_CONNECT_TIMEOUT_SECONDS=5'
  'BROKER_READ_TIMEOUT_SECONDS=15'
  'BROKER_PRODUCTION_ENABLED=false'
  'BROKER_PRODUCTION_ACK='
  'BROKER_PRODUCTION_CONFIRMATION='
  'SETTRADE_BROKER_ID='
)
[IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)

Write-Host 'UAT setup complete. Secrets were not printed.' -ForegroundColor Green
& $pythonExe (Join-Path $gatewayDir 'uat_readiness.py')
Write-Host 'Next: run check_uat.ps1 with PowerShell. It starts and verifies UAT read-only.' -ForegroundColor Cyan
