@echo off
cd /d "%~dp0"
where /q node
if errorlevel 1 (
  echo Node.js n est pas installe. Telechargez-le sur https://nodejs.org puis relancez ce fichier.
  pause
  exit /b
)
start "" http://localhost:8080
node tools\serve.mjs
pause
