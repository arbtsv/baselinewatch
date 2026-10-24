@echo off
rem monitor.bat - one baselinewatch run. Exit code: 0 pass, 1 fail, 3 not ready.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" --version >nul 2>&1
if errorlevel 1 goto nonode
if not exist "node_modules\baselinewatch\dist\cli.js" goto nocore
"%NODE%" "node_modules\baselinewatch\dist\cli.js" run %*
set "RC=%ERRORLEVEL%"
exit /b %RC%

:nonode
echo Node.js was not found. Run install.bat or put node.exe into the node folder next to this file.
echo REASON=node
goto fail
:nocore
echo baselinewatch is not installed here. Run install.bat or npm ci.
echo REASON=config
:fail
echo RESULT=FAIL
exit /b 3
