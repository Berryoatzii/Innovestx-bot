param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('AppId', 'Metadata', 'AppSecret', 'AllPage')]
  [string]$Field
)

$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$stagePath = Join-Path $gatewayDir '.uat-credential-stage.json'
$envPath = Join-Path $gatewayDir '.env'
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Read-Stage {
  if (-not (Test-Path -LiteralPath $stagePath)) { return @{} }
  $raw = Get-Content -Raw -LiteralPath $stagePath -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
  $object = $raw | ConvertFrom-Json
  $result = @{}
  foreach ($property in $object.PSObject.Properties) { $result[$property.Name] = [string]$property.Value }
  return $result
}

function Write-Stage([hashtable]$Stage) {
  $json = $Stage | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($stagePath, $json, $utf8NoBom)
}

function Clear-SecureClipboard {
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.Clipboard]::Clear()
}

$clipboard = [string](Get-Clipboard -Raw)
$clipboard = $clipboard.Trim()
if ([string]::IsNullOrWhiteSpace($clipboard)) { throw 'Clipboard is empty.' }
$stage = Read-Stage

switch ($Field) {
  'AppId' {
    if ($clipboard -notmatch '^[A-Za-z0-9._-]{8,200}$') { throw 'Clipboard is not a valid UAT App ID.' }
    $stage['appId'] = $clipboard
    Write-Stage $stage
    Write-Host 'UAT App ID captured without printing it.' -ForegroundColor Green
  }
  'Metadata' {
    if ($clipboard -notmatch '(?im)^\s*Broker\s+ID\s*:\s*SANDBOX\s*$') { throw 'Sandbox Broker ID was not found.' }
    if ($clipboard -notmatch '(?im)^\s*App\s+Code\s*:\s*SANDBOX\s*$') { throw 'Sandbox App Code was not found.' }
    $account = [regex]::Match($clipboard, '(?im)^\s*Equity\s+Account\s*:\s*([A-Za-z0-9._-]{3,40})\s*$')
    $pin = [regex]::Match($clipboard, '(?im)^\s*PIN\s*:\s*([0-9]{4,12})\s*$')
    if (-not $account.Success -or -not $pin.Success) { throw 'Sandbox account metadata is incomplete.' }
    $stage['accountNo'] = $account.Groups[1].Value
    $stage['pin'] = $pin.Groups[1].Value
    Write-Stage $stage
    Write-Host 'Sandbox metadata captured without printing account data.' -ForegroundColor Green
  }
  'AppSecret' {
    if ($clipboard -notmatch '^[A-Za-z0-9+/=_-]{12,300}$') { throw 'Clipboard is not a valid UAT App Secret.' }
    foreach ($required in @('appId', 'accountNo', 'pin')) {
      if ([string]::IsNullOrWhiteSpace([string]$stage[$required])) { throw "UAT staging is missing $required." }
    }
    if (Test-Path -LiteralPath $envPath) {
      $existing = Get-Content -Raw -LiteralPath $envPath -Encoding UTF8
      if ($existing -match '(?im)^BROKER_ENVIRONMENT=prod\s*$') { throw 'Refusing to overwrite a production environment.' }
    }
    $tokenBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
    $gatewayToken = ([BitConverter]::ToString($tokenBytes) -replace '-', '').ToLowerInvariant()
    $lines = @(
      'BROKER_ENVIRONMENT=uat'
      "SETTRADE_APP_ID=$($stage['appId'])"
      "SETTRADE_APP_SECRET=$clipboard"
      'SETTRADE_APP_CODE=SANDBOX'
      "SETTRADE_ACCOUNT_NO=$($stage['accountNo'])"
      "SETTRADE_PIN=$($stage['pin'])"
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
    Remove-Item -LiteralPath $stagePath -Force
    Clear-SecureClipboard
    Write-Host 'UAT credentials saved locally. Secret and PIN were not printed. Clipboard cleared.' -ForegroundColor Green
  }
  'AllPage' {
    $appId = [regex]::Match($clipboard, '(?im)^Application\s+Id[ \t]*\r?\n[ \t]*([A-Za-z0-9._-]{8,200})[ \t]*\r?$')
    $appSecret = [regex]::Match($clipboard, '(?im)^Application\s+Secret[ \t]*\r?\n[ \t]*([A-Za-z0-9+/=_-]{12,300})[ \t]*\r?$')
    $broker = [regex]::Match($clipboard, '(?im)^\s*Broker\s+ID\s*:\s*(SANDBOX)\s*$')
    $appCode = [regex]::Match($clipboard, '(?im)^\s*App\s+Code\s*:\s*(SANDBOX)\s*$')
    $account = [regex]::Match($clipboard, '(?im)^\s*Equity\s+Account\s*:\s*([A-Za-z0-9._-]{3,40})\s*$')
    $pin = [regex]::Match($clipboard, '(?im)^\s*PIN\s*:\s*([0-9]{4,12})\s*$')
    if (-not $appId.Success -or -not $appSecret.Success -or -not $broker.Success -or -not $appCode.Success -or -not $account.Success -or -not $pin.Success) {
      throw 'The copied Settrade Sandbox page is missing one or more credential fields.'
    }
    if (Test-Path -LiteralPath $envPath) {
      $existing = Get-Content -Raw -LiteralPath $envPath -Encoding UTF8
      if ($existing -match '(?im)^BROKER_ENVIRONMENT=prod\s*$') { throw 'Refusing to overwrite a production environment.' }
    }
    $tokenBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
    $gatewayToken = ([BitConverter]::ToString($tokenBytes) -replace '-', '').ToLowerInvariant()
    $lines = @(
      'BROKER_ENVIRONMENT=uat'
      "SETTRADE_APP_ID=$($appId.Groups[1].Value)"
      "SETTRADE_APP_SECRET=$($appSecret.Groups[1].Value)"
      'SETTRADE_APP_CODE=SANDBOX'
      "SETTRADE_ACCOUNT_NO=$($account.Groups[1].Value)"
      "SETTRADE_PIN=$($pin.Groups[1].Value)"
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
    if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Force }
    Clear-SecureClipboard
    Write-Host 'All UAT credentials were captured from the page without printing them. Clipboard cleared.' -ForegroundColor Green
  }
}
