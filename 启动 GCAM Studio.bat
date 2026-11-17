@echo off
setlocal
cd /d "%~dp0"
REM Some shells set this globally; Electron must not run as Node.
set ELECTRON_RUN_AS_NODE=
if exist "release\win-unpacked\GCAM-China Studio.exe" (
  start "" "release\win-unpacked\GCAM-China Studio.exe"
) else (
  set GCAM_STUDIO_DEV=1
  start "" "node_modules\electron\dist\electron.exe" .
)
