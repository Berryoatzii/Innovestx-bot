$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonExe = Join-Path $gatewayDir '.venv\Scripts\python.exe'
$envPath = Join-Path $gatewayDir '.env'
$gatewayScript = Join-Path $gatewayDir 'gateway.py'
$verifyScript = Join-Path $gatewayDir 'verify_uat.ps1'
$readinessScript = Join-Path $gatewayDir 'uat_readiness.py'

if (-not (Test-Path -LiteralPath $pythonExe)) {
  throw 'Gateway is not installed. Run setup_uat.ps1 first.'
}
& $pythonExe $readinessScript
if (-not (Test-Path -LiteralPath $envPath)) {
  throw 'UAT credentials are missing. Run setup_uat.ps1 first.'
}

$env:BROKER_GATEWAY_ENV_FILE = $envPath
$startedProcess = $null

try {
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) {
    Write-Host 'Starting the local UAT gateway...' -ForegroundColor Yellow
    $startedProcess = Start-Process -FilePath $pythonExe -ArgumentList @($gatewayScript) -WorkingDirectory $gatewayDir -WindowStyle Hidden -PassThru
  } else {
    Write-Host 'The local UAT gateway is already running.' -ForegroundColor Cyan
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    if ($startedProcess -and $startedProcess.HasExited) {
      throw 'The UAT gateway stopped during startup.'
    }
    try {
      $connection = New-Object Net.Sockets.TcpClient
      try {
        $connection.Connect('127.0.0.1', 8787)
        $ready = $true
        break
      } finally {
        $connection.Dispose()
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) { throw 'The UAT gateway did not start within the safety timeout.' }

  & $verifyScript
  if ($LASTEXITCODE -ne 0) { throw 'Read-only UAT verification failed.' }
  & $pythonExe (Join-Path $gatewayDir 'show_uat_portfolio.py')
  if ($LASTEXITCODE -ne 0) { throw 'Read-only UAT portfolio view failed.' }
  Write-Host 'UAT CHECK PASSED. No real account and no order were used.' -ForegroundColor Green
  if ($startedProcess) {
    Write-Host "Gateway remains active in the background (PID $($startedProcess.Id))." -ForegroundColor Cyan
  }
} catch {
  if ($startedProcess -and -not $startedProcess.HasExited) {
    Stop-Process -Id $startedProcess.Id
  }
  throw
}
