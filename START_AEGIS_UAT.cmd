@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AEGIS Settrade Sandbox
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0AEGIS_MENU.ps1"
if errorlevel 1 (
  echo.
  echo AEGIS stopped with an error. Real-money trading remains locked.
  pause
)
