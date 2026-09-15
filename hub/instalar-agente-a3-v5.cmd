@echo off
setlocal
title DocPronto - Agente A3
color 0F

echo.
echo ============================================
echo       DOCPRONTO - AGENTE LOCAL A3 V5
echo ============================================
echo.
echo Este agente permite que o DocPronto localize
echo certificados no token ou cartao deste Windows.
echo O PIN nao sera armazenado pelo DocPronto.
echo.

where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] O Node.js nao foi localizado neste Windows.
  echo Conclua a instalacao do Node.js LTS ou reinicie o computador.
  echo Depois execute este arquivo novamente.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
echo Node.js localizado:
node --version

set "AGENT_DIR=%LOCALAPPDATA%\DocProntoAgent"
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"

echo Baixando a versao atual do agente...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Nikodeimus/DocPronto/main/server-a3-v5.mjs' -OutFile '%AGENT_DIR%\server-a3-v5.mjs' } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo [ERRO] Nao foi possivel baixar o agente.
  pause
  exit /b 1
)

echo.
echo Encerrando a versao antiga do agente na porta 4174...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue; foreach ($item in $items) { $process = Get-Process -Id $item.OwningProcess -ErrorAction SilentlyContinue; if ($process -and $process.ProcessName -eq 'node') { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } }"
timeout /t 2 /nobreak >nul
echo Iniciando a versao atual em 127.0.0.1:4174...
start "DocPronto - Agente A3 (mantenha aberto)" /D "%AGENT_DIR%" cmd /k "set PORT=4174&& node server-a3-v5.mjs"
timeout /t 3 /nobreak >nul
start "" "https://nikodeimus.github.io/DocPronto/hub/?v=dfe-9"

echo.
echo Agente V5 iniciado. Mantenha a nova janela aberta
echo durante o uso do certificado A3.
timeout /t 5 /nobreak >nul
endlocal
