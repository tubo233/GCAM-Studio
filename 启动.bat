@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title GCAM-China Studio - Source 0.1.2
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-source.ps1" %*
set "GCAM_EXIT=%errorlevel%"
if not "%GCAM_EXIT%"=="0" (
  echo.
  echo Startup failed. Read the error above before closing this window.
  pause
)
exit /b %GCAM_EXIT%
