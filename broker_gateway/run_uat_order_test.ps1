$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'

& (Join-Path $gatewayDir 'check_uat.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Read-only UAT check must pass before an order lifecycle test.' }

Write-Host ''
Write-Host 'UAT/Sandbox order test only. Real money remains locked.' -ForegroundColor Yellow
$symbol = (Read-Host 'Stock symbol, for example AOT').Trim().ToUpperInvariant()
$side = (Read-Host 'BUY or SELL').Trim().ToUpperInvariant()
$quantityText = (Read-Host 'Quantity (board lot 100)').Trim()
$priceText = (Read-Host 'Limit price, for example 20.00').Trim()

$quantity = 0
if (-not [int]::TryParse($quantityText, [ref]$quantity) -or $quantity -le 0) {
  throw 'Invalid quantity.'
}
if ($priceText -notmatch '^\d+(\.\d{1,4})?$') { throw 'Invalid price. Example: 20.00' }
if ($side -notin @('BUY', 'SELL')) { throw 'Side must be BUY or SELL.' }

Write-Host ''
Write-Host 'The test will place a UAT Limit order, prove duplicate protection, and cancel when possible.' -ForegroundColor Cyan
$confirmation = Read-Host 'Type SEND_UAT_ORDER_ONLY to confirm'
if ($confirmation -cne 'SEND_UAT_ORDER_ONLY') { throw 'Cancelled: exact UAT confirmation was not entered.' }

$env:BROKER_GATEWAY_ENV_FILE = $envPath
& $pythonExe (Join-Path $gatewayDir 'uat_order_cycle.py') `
  --symbol $symbol --side $side --quantity $quantity --price $priceText --confirm $confirmation
if ($LASTEXITCODE -ne 0) { throw "UAT order lifecycle test is incomplete (exit $LASTEXITCODE)." }
