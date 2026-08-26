$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $gatewayDir '.env.production-readonly'
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$utf8NoBom = New-Object Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $pythonExe)) {
  throw 'Python environment is missing. Run setup_uat.ps1 first.'
}

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host 'INVX Production READ-ONLY setup. This cannot place or cancel orders.' -ForegroundColor Yellow
$appId = Read-Host 'ALGO_EQ Production App ID'
$appSecret = Read-PlainSecret 'ALGO_EQ Production App Secret (hidden)'
$accountNo = Read-Host 'INVX Thai-equity account number'
$pin = Read-PlainSecret 'INVX account PIN (hidden)'

if ([string]::IsNullOrWhiteSpace($appId) -or
    [string]::IsNullOrWhiteSpace($appSecret) -or
    [string]::IsNullOrWhiteSpace($accountNo) -or
    [string]::IsNullOrWhiteSpace($pin)) {
  throw 'All credential fields are required.'
}

$tokenBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
$gatewayToken = ([BitConverter]::ToString($tokenBytes) -replace '-', '').ToLowerInvariant()

$lines = @(
  'BROKER_ENVIRONMENT=prod'
  "SETTRADE_APP_ID=$appId"
  "SETTRADE_APP_SECRET=$appSecret"
  'SETTRADE_APP_CODE=ALGO_EQ'
  'SETTRADE_BROKER_ID=023'
  "SETTRADE_ACCOUNT_NO=$accountNo"
  "SETTRADE_PIN=$pin"
  "BROKER_GATEWAY_TOKEN=$gatewayToken"
  'BROKER_GATEWAY_HOST=127.0.0.1'
  'BROKER_GATEWAY_PORT=8788'
  'BROKER_JOURNAL_PATH=broker-journal-production-readonly.sqlite3'
  'BROKER_MAX_ORDER_VALUE=1'
  'BROKER_CASH_FIELD=cashBalance'
  'BROKER_REQUIRED_ACCOUNT_TYPE='
  'BROKER_BOARD_LOT=100'
  'BROKER_BOARD_LOT_OVERRIDES_JSON={}'
  'BROKER_CASH_BUFFER_BPS=100'
  'BROKER_CONNECT_TIMEOUT_SECONDS=5'
  'BROKER_READ_TIMEOUT_SECONDS=15'
  'BROKER_PRODUCTION_READ_ONLY=true'
  'BROKER_PRODUCTION_ENABLED=false'
  'BROKER_PRODUCTION_ACK='
  'BROKER_PRODUCTION_CONFIRMATION='
)
[IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)

& $pythonExe (Join-Path $gatewayDir 'verify_production_readonly_config.py') $envPath
if ($LASTEXITCODE -ne 0) { throw 'Production read-only configuration validation failed.' }

Write-Host 'Saved locally as .env.production-readonly. UAT .env was not changed.' -ForegroundColor Green
Write-Host 'No order was sent. Production order execution remains locked.' -ForegroundColor Green
