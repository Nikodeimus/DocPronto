@echo off
setlocal
title DocPronto - Agente de Certificados V19
color 0F

echo.
echo =============================================
echo       DOCPRONTO - AGENTE DE CERTIFICADOS V19
echo =============================================
echo.
echo Esta versao bloqueia consultas ate o A3 ser liberado.
echo Mantenha o token/cartao no leitor. Ao consultar,
echo informe o PIN somente na janela segura do Windows.
echo O PIN e a senha do certificado nao sao salvos.
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
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Nikodeimus/DocPronto/main/server-cert-v8.mjs?v=cert-19' -OutFile '%AGENT_DIR%\server-cert-v19.mjs' } catch { Write-Host $_.Exception.Message; exit 1 }"
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
start "DocPronto - Agente V19 (mantenha aberto)" /D "%AGENT_DIR%" cmd /k "set PORT=4174&& node server-cert-v19.mjs"
timeout /t 3 /nobreak >nul
start "" "https://nikodeimus.github.io/DocPronto/hub/?v=cert-19"

echo.
echo Agente de certificados V19 iniciado. Mantenha a nova janela aberta.
timeout /t 5 /nobreak >nul
endlocal



