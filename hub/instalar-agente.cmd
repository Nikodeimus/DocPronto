@echo off
setlocal EnableExtensions EnableDelayedExpansion
title DocPronto - Instalador do Agente V22
color 0F

set "RELEASE=2026.09.16-cert.22"
set "EXPECTED_SHA256=d403533f11aa3b87ab76d1aa60f2233407b2fc7e9c87c781393bbf049352586c"
set "AGENT_DIR=%LOCALAPPDATA%\DocProntoAgent"
set "AGENT_FILE=%AGENT_DIR%\server.mjs"
set "DOWNLOAD_FILE=%AGENT_DIR%\server.download.mjs"
set "LOG_FILE=%AGENT_DIR%\instalacao.log"
set "AGENT_URL=https://raw.githubusercontent.com/Nikodeimus/DocPronto/main/server-cert-v8.mjs?v=%RELEASE%"

if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"
>"%LOG_FILE%" echo DocPronto %RELEASE% - diagnostico de instalacao
>>"%LOG_FILE%" echo Inicio: %DATE% %TIME%

echo.
echo =============================================
echo       DOCPRONTO - AGENTE LOCAL V22
echo =============================================
echo.
echo Esta versao migra automaticamente agentes V7-V21,
echo valida o download e deixa um diagnostico se falhar.
echo.

where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  set "FAILURE=O Node.js LTS nao foi localizado neste Windows."
  start "" "https://nodejs.org/en/download"
  goto :failure
)
for /f "delims=" %%I in ('node --version') do >>"%LOG_FILE%" echo Node.js: %%I

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))"`) do set "AGENT_TOKEN=%%I"
if not defined AGENT_TOKEN (
  set "FAILURE=Nao foi possivel criar o pareamento seguro do agente."
  goto :failure
)

echo [1/4] Baixando e validando o agente...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { Invoke-WebRequest -UseBasicParsing $env:AGENT_URL -OutFile $env:DOWNLOAD_FILE; $hash=(Get-FileHash -Algorithm SHA256 $env:DOWNLOAD_FILE).Hash.ToLowerInvariant(); if ($hash -ne $env:EXPECTED_SHA256) { throw ('Integridade invalida. Esperado ' + $env:EXPECTED_SHA256 + ', recebido ' + $hash) }; Add-Content -Path $env:LOG_FILE -Value ('Download validado: ' + $hash) } catch { Add-Content -Path $env:LOG_FILE -Value ('ERRO DOWNLOAD: ' + $_.Exception.Message); Write-Host ('[ERRO] ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
  set "FAILURE=Falha ao baixar ou validar o agente."
  goto :failure
)

echo [2/4] Encerrando somente agentes antigos do DocPronto...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $items=Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue; foreach($item in $items){ $process=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.OwningProcess) -ErrorAction SilentlyContinue; $command=[string]$process.CommandLine; $isCurrent=$command -match '(?i)(^|[\\/\x22\s])server\.mjs(?=$|[\x22\s])'; $isLegacy=$command -match '(?i)(^|[\\/\x22\s])server-(cert|a3)(-v\d+)?\.mjs(?=$|[\x22\s])'; if($process -and $process.Name -eq 'node.exe' -and ($isCurrent -or $isLegacy)){ Add-Content -Path $env:LOG_FILE -Value ('Encerrando agente anterior PID ' + $item.OwningProcess + ': ' + $command); Stop-Process -Id $item.OwningProcess -Force -ErrorAction Stop } else { $detail=('Porta 4174 ocupada por PID ' + $item.OwningProcess + ', processo ' + $process.Name + ', comando ' + $command); Add-Content -Path $env:LOG_FILE -Value ('ERRO PORTA: ' + $detail); throw $detail } } } catch { Write-Host ('[ERRO] ' + $_.Exception.Message); exit 2 }"
if errorlevel 1 (
  set "FAILURE=A porta 4174 esta ocupada por um programa que nao foi reconhecido como DocPronto."
  goto :failure
)

timeout /t 1 /nobreak >nul
move /y "%DOWNLOAD_FILE%" "%AGENT_FILE%" >nul
if errorlevel 1 (
  set "FAILURE=Nao foi possivel instalar o arquivo do agente em %AGENT_DIR%."
  goto :failure
)

echo [3/4] Iniciando o agente em 127.0.0.1:4174...
start "DocPronto - Agente Local V22 (mantenha aberto)" /D "%AGENT_DIR%" cmd /k "set PORT=4174&& set DOCPRONTO_AGENT_TOKEN=%AGENT_TOKEN%&& node server.mjs --docpronto-agent"
timeout /t 4 /nobreak >nul

echo [4/4] Confirmando a inicializacao...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $headers=@{'X-DocPronto-Token'=$env:AGENT_TOKEN}; $health=Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:4174/api/health' -Headers $headers -TimeoutSec 10; if($health.agentVersion -ne $env:RELEASE){throw ('Versao iniciada: ' + $health.agentVersion + '; esperada: ' + $env:RELEASE)}; Add-Content -Path $env:LOG_FILE -Value ('SUCESSO: Agente ' + $health.agentVersion + ' online.'); Write-Host ('[OK] Agente ' + $health.agentVersion + ' online.') } catch { Add-Content -Path $env:LOG_FILE -Value ('ERRO HEALTH: ' + $_.Exception.Message); Write-Host ('[ERRO] ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
  set "FAILURE=O agente foi iniciado, mas nao confirmou que esta online."
  goto :failure
)

start "" "https://nikodeimus.github.io/DocPronto/hub/?v=%RELEASE%#agent=%AGENT_TOKEN%"
echo.
echo [SUCESSO] Agente V22 atualizado, pareado e online.
echo Mantenha aberta a janela chamada DocPronto - Agente Local V22.
timeout /t 6 /nobreak >nul
exit /b 0

:failure
if exist "%DOWNLOAD_FILE%" del /q "%DOWNLOAD_FILE%" >nul 2>nul
>>"%LOG_FILE%" echo FALHA: !FAILURE!
echo.
echo [ERRO] !FAILURE!
echo O diagnostico sera aberto no Bloco de Notas:
echo %LOG_FILE%
start "" notepad.exe "%LOG_FILE%"
echo.
echo Esta janela ficara aberta ate voce pressionar uma tecla.
pause >nul
exit /b 1
