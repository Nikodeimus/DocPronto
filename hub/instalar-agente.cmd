@echo off
setlocal EnableExtensions
title DocPronto - Agente Local
color 0F

set "RELEASE=2026.09.16-cert.21"
set "EXPECTED_SHA256=aaa358644c9adc2e026293bfef733e193e0b448f39443273a55bd8f424138f3a"
set "AGENT_DIR=%LOCALAPPDATA%\DocProntoAgent"
set "AGENT_FILE=%AGENT_DIR%\server.mjs"
set "DOWNLOAD_FILE=%AGENT_DIR%\server.download.mjs"
set "AGENT_URL=https://raw.githubusercontent.com/Nikodeimus/DocPronto/main/server-cert-v8.mjs?v=%RELEASE%"

echo.
echo =============================================
echo       DOCPRONTO - AGENTE LOCAL %RELEASE%
echo =============================================
echo.
echo Este instalador valida a integridade do agente,
echo preserva outros processos Node e testa a inicializacao.
echo O PIN do A3 permanece na janela segura do token.
echo.

where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] O Node.js LTS nao foi localizado.
  echo Instale o Node.js, reinicie o Windows e execute este arquivo novamente.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"
for /f "delims=" %%I in ('powershell -NoProfile -Command "([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))"') do set "AGENT_TOKEN=%%I"
if not defined AGENT_TOKEN (
  echo [ERRO] Nao foi possivel criar o pareamento seguro do agente.
  pause
  exit /b 1
)

echo Baixando o agente %RELEASE%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing $env:AGENT_URL -OutFile $env:DOWNLOAD_FILE; $hash=(Get-FileHash -Algorithm SHA256 $env:DOWNLOAD_FILE).Hash.ToLowerInvariant(); if ($hash -ne $env:EXPECTED_SHA256) { throw ('Integridade invalida. Esperado ' + $env:EXPECTED_SHA256 + ', recebido ' + $hash) }; Move-Item -Force $env:DOWNLOAD_FILE $env:AGENT_FILE } catch { Write-Host ('[ERRO] ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
  if exist "%DOWNLOAD_FILE%" del /q "%DOWNLOAD_FILE%"
  pause
  exit /b 1
)

echo Verificando a porta local 4174...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$items=Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue; foreach($item in $items){$process=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.OwningProcess) -ErrorAction SilentlyContinue; if($process -and $process.CommandLine -like ('*' + $env:AGENT_DIR + '*server.mjs*')){Stop-Process -Id $item.OwningProcess -Force -ErrorAction Stop}else{Write-Host '[ERRO] A porta 4174 pertence a outro programa e nao sera encerrada.'; exit 2}}"
if errorlevel 1 (
  echo Feche o programa indicado ou altere a porta antes de continuar.
  pause
  exit /b 1
)

echo Iniciando o agente em 127.0.0.1:4174...
start "DocPronto - Agente Local (mantenha aberto)" /D "%AGENT_DIR%" cmd /k "set PORT=4174&& set DOCPRONTO_AGENT_TOKEN=%AGENT_TOKEN%&& node server.mjs"
timeout /t 3 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "try {$headers=@{'X-DocPronto-Token'=$env:AGENT_TOKEN}; $health=Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:4174/api/health' -Headers $headers -TimeoutSec 8; if($health.agentVersion -ne $env:RELEASE){throw ('Versao iniciada: ' + $health.agentVersion)}; Write-Host ('[OK] Agente ' + $health.agentVersion + ' online.')}catch{Write-Host ('[ERRO] O agente nao confirmou a inicializacao: ' + $_.Exception.Message);exit 1}"
if errorlevel 1 (
  pause
  exit /b 1
)

start "" "https://nikodeimus.github.io/DocPronto/hub/?v=%RELEASE%#agent=%AGENT_TOKEN%"
echo.
echo Agente atualizado e validado. Mantenha a janela do agente aberta.
timeout /t 5 /nobreak >nul
endlocal
