$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $gatewayDir '.env.production-readonly'
$runner = Join-Path $gatewayDir 'run_production_readonly_watchdog.ps1'
$taskName = 'AEGIS-Production-ReadOnly-Watchdog'

if (-not (Test-Path -LiteralPath $envPath)) { throw 'Production read-only configuration is missing.' }
if (-not (Test-Path -LiteralPath $runner)) { throw 'Production read-only watchdog runner is missing.' }

$safeConfig = @{}
foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
  if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
    $safeConfig[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
  }
}
if ($safeConfig['BROKER_ENVIRONMENT'] -ne 'prod') { throw 'PRODUCTION_ONLY' }
if ($safeConfig['BROKER_PRODUCTION_READ_ONLY'] -ne 'true') { throw 'READ_ONLY_REQUIRED' }
if ($safeConfig['BROKER_PRODUCTION_ENABLED'] -ne 'false') { throw 'PRODUCTION_MUTATIONS_MUST_BE_DISABLED' }
if ($safeConfig['BROKER_PRODUCTION_ACK'] -or $safeConfig['BROKER_PRODUCTION_CONFIRMATION']) { throw 'ORDER_UNLOCKS_FORBIDDEN' }
if ($safeConfig['BROKER_GATEWAY_HOST'] -notin @('127.0.0.1', 'localhost', '::1')) { throw 'LOOPBACK_ONLY' }

$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershellExe)) {
  $powershellExe = (Get-Command pwsh.exe -ErrorAction Stop).Source
}
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $arguments -WorkingDirectory $gatewayDir
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action `
  -Trigger @($logonTrigger, $periodicTrigger) -Settings $settings `
  -Principal $principal -Description 'Production read-only gateway watchdog; GET only and mutations disabled.' -Force | Out-Null

Write-Host "Installed $taskName (Production Read-Only only, every 5 minutes)." -ForegroundColor Green
Write-Host 'This task refuses production order unlocks and never calls a mutation endpoint.' -ForegroundColor Cyan
