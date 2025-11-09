@echo off
REM Close any existing Chrome instances
taskkill /F /IM chrome.exe /T >nul 2>&1

REM Wait a moment for Chrome to close
timeout /t 2 /nobreak >nul

REM Start Chrome with remote debugging enabled using your regular profile
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data"

echo Chrome started with remote debugging on port 9222
echo You can now use MCP to connect to this Chrome instance
