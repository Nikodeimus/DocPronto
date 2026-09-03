@echo off
setlocal
chcp 65001 >nul
set "TARGET=%USERPROFILE%\Documents\DOCPronto"
set "SOURCE=%~dp0server.mjs"
set "DOWNLOADED=%TEMP%\docpronto-server-v4.mjs"

if not exist "%SOURCE%" (
  echo Baixando o motor seguro do DOCPronto...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing 'https://docpronto-online.podpapiruscast.chatgpt.site/docpronto/downloads/server.mjs?v=4' -OutFile $env:TEMP\docpronto-server-v4.mjs"
  if not exist "%DOWNLOADED%" (
    echo ERRO: nao foi possivel baixar o motor atualizado.
    pause
    exit /b 1
  )
  set "SOURCE=%DOWNLOADED%"
)

findstr /C:"pdfSigningEngine: 4" "%SOURCE%" >nul
if errorlevel 1 (
  echo ERRO: o motor baixado nao corresponde a versao segura 4.
  pause
  exit /b 1
)

if not exist "%TARGET%" (
  echo ERRO: a pasta "%TARGET%" nao foi encontrada.
  echo Extraia este ZIP e execute o atualizador neste computador.
  pause
  exit /b 1
)

if not exist "%TARGET%\vendor" mkdir "%TARGET%\vendor"
if not exist "%TARGET%\vendor\pdf-lib.min.js" (
  echo Baixando o normalizador de PDF...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing 'https://docpronto-online.podpapiruscast.chatgpt.site/docpronto/vendor/pdf-lib.min.js' -OutFile '%TARGET%\vendor\pdf-lib.min.js'"
)
if not exist "%TARGET%\vendor\pdf-lib.min.js" (
  echo ERRO: o normalizador de PDF nao pode ser instalado.
  pause
  exit /b 1
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":4173 .*LISTENING" /C:":4174 .*LISTENING"') do taskkill /F /PID %%P >nul 2>&1
if exist "%TARGET%\server.mjs" copy /Y "%TARGET%\server.mjs" "%TARGET%\server.mjs.backup" >nul
copy /Y "%SOURCE%" "%TARGET%\server.mjs" >nul

findstr /C:"pdfSigningEngine: 4" "%TARGET%\server.mjs" >nul
if errorlevel 1 (
  echo ERRO: nao foi possivel confirmar a atualizacao do conector.
  pause
  exit /b 1
)

echo Conector do DOCPronto atualizado com seguranca para a versao 4.
if exist "%TARGET%\ABRIR DOCPRONTO.cmd" start "" "%TARGET%\ABRIR DOCPRONTO.cmd"
if not exist "%TARGET%\ABRIR DOCPRONTO.cmd" if exist "%TARGET%\abrir-docpronto.cmd" start "" "%TARGET%\abrir-docpronto.cmd"
pause
