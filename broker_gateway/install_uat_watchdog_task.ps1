$ErrorActionPreference = 'Stop'
$gatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $gatewayDir '.env'
$runner = Join-Path $gatewayDir 'run_uat_watchdog.ps1'
$taskName = 'AEGIS-UAT-Watchdog'

if (-not (Test-Path -LiteralPath $envPath)) { throw 'UAT configuration is missing.' }
if (-not (Test-Path -LiteralPath $runner)) { throw 'UAT watchdog runner is missing.' }

$safeConfig = @{}
foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
  if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
    $safeConfig[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
  }
}
if ($safeConfig['BROKER_ENVIRONMENT'] -ne 'uat') { throw 'UAT_ONLY' }
if ($safeConfig['BROKER_PRODUCTION_ENABLED'] -ne 'false') { throw 'PRODUCTION_MUST_BE_DISABLED' }
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
  -Principal $principal -Description 'Read-only UAT gateway health watchdog; never sends orders.' -Force | Out-Null

Write-Host "Installed $taskName (UAT only, every 5 minutes)." -ForegroundColor Green
Write-Host 'This task never places, changes, or cancels an order.' -ForegroundColor Cyan
