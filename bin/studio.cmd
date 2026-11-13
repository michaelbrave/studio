@echo off
rem Launcher for `studio` on Windows: find a Node new enough for Studio, then run bin\studio.ts.
setlocal
set "NODE=%LOCALAPPDATA%\studio\node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul || (echo studio: Node is not installed. Run install.ps1 & exit /b 1)
  set "NODE=node"
)
"%NODE%" --disable-warning=ExperimentalWarning "%~dp0studio.ts" %*
