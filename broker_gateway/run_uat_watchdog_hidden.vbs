' Launches the UAT watchdog PowerShell script completely hidden (no window flash).
' Window mode 0 = hidden; second arg False = do not wait.
Dim shell, scriptDir, ps1
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ps1 = scriptDir & "run_uat_watchdog.ps1"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
