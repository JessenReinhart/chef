@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :missing_node

where npm >nul 2>nul
if errorlevel 1 goto :missing_npm

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-windows-launcher.ps1" -Quiet >nul 2>nul

npm run chef
if errorlevel 1 goto :failed
exit /b 0

:missing_node
echo.
echo Chef needs Node.js 24 or later.
echo Install Node.js, then run Chef.cmd again.
echo.
pause
exit /b 1

:missing_npm
echo.
echo Chef could not find npm.
echo Reinstall Node.js 24 or later with npm included, then run Chef.cmd again.
echo.
pause
exit /b 1

:failed
echo.
echo Chef could not start. Review the message above for the cause.
echo You can also run: npm run doctor
echo.
pause
exit /b 1
