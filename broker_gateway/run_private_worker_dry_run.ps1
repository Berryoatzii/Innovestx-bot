$ErrorActionPreference = 'Stop'
$gatewayDir = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$worker = Join-Path $gatewayDir 'private_worker.py'
$envPath = Join-Path $gatewayDir '.env.production-readonly'
$statusPath = Join-Path $gatewayDir '.private-worker-dry-run-status.json'

if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) { throw 'Python environment is missing.' }
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'Private worker is missing.' }
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw 'Production read-only config is missing.' }

$output = & $pythonExe $worker --env-file $envPath 2>&1
$exitCode = $LASTEXITCODE
$result = [ordered]@{
  checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
  mode = 'PRODUCTION_READ_ONLY_DRY_RUN'
  exitCode = $exitCode
  safe = $false
}
try {
  $payload = ($output | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
  $result.safe = ($exitCode -eq 0 -and $payload.mode -eq 'DRY_RUN' -and $payload.claimed -eq $false)
  $result.gatewayReady = ($payload.ready -eq $true)
  $result.releasePassed = ($payload.releasePassed -eq $true)
  $result.releaseBlockerCount = [int]$payload.releaseBlockerCount
} catch {
  $result.error = 'PRIVATE_WORKER_DRY_RUN_OUTPUT_INVALID'
}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding UTF8
if (-not $result.safe) { exit 1 }
exit 0
