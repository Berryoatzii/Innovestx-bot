$ErrorActionPreference = 'Stop'
$gatewayDir = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$runner = Join-Path $gatewayDir 'run_private_worker_dry_run.ps1'
$taskName = 'AEGIS-Private-Worker-Dry-Run'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Private worker dry-run runner is missing.' }

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
  -Principal $principal -Description 'AEGIS production read-only private-worker dry-run; never claims or sends orders.' -Force | Out-Null

Write-Host "Installed $taskName (read-only dry-run every 5 minutes)." -ForegroundColor Green
Write-Host 'This task cannot claim an intent or call a broker mutation.' -ForegroundColor Cyan
