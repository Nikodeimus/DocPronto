@echo off
setlocal
title DocPronto - Agente A3
color 0F

echo.
echo ============================================
echo       DOCPRONTO - AGENTE LOCAL A3
echo ============================================
echo.
echo Este agente permite que o DocPronto localize
echo certificados no token ou cartao deste Windows.
echo O PIN nao sera armazenado pelo DocPronto.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] O Node.js ainda nao esta instalado.
  echo Instale a versao LTS e execute este arquivo novamente.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

set "AGENT_DIR=%LOCALAPPDATA%\DocProntoAgent"
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"

echo Baixando a versao atual do agente...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Nikodeimus/DocPronto/main/server.mjs' -OutFile '%AGENT_DIR%\server.mjs' } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo [ERRO] Nao foi possivel baixar o agente.
  pause
  exit /b 1
)

echo.
echo Iniciando em 127.0.0.1:4173...
start "DocPronto - Agente A3 (mantenha aberto)" cmd /k "cd /d \"%AGENT_DIR%\" && node server.mjs"
timeout /t 3 /nobreak >nul
start "" "https://nikodeimus.github.io/DocPronto/hub/?v=a3-3"

echo.
echo Agente iniciado. Mantenha a nova janela aberta
echo durante o uso do certificado A3.
timeout /t 5 /nobreak >nul
endlocal
