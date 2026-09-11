@echo off
start "SutraAI - Server" cmd /k "cd /d "%~dp0server" && npm.cmd run dev"
start "SutraAI - Client" cmd /k "cd /d "%~dp0client" && npm.cmd run dev"
echo SutraAI starting...
echo   Server: http://localhost:4000
echo   App:    http://localhost:5173