@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title NAYRAFOOD RESTAURANTE - APP y API

echo ====================================================
echo      NAYRAFOOD RESTAURANTE - APP Y API
echo          UNA SOLA CONSOLA, DOS SERVICIOS
echo ====================================================

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: instala Node.js 22.13 o superior.
  timeout /t 8 /nobreak >nul
  exit /b 1
)

powershell -NoProfile -Command "try { $health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 2; $web = Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2; if (($health.version -eq '6.1.2-restaurante') -and ($web.StatusCode -eq 200)) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo NAYRAFOOD v6.1.2 ya esta ejecutandose. No se abriran servicios duplicados.
  start "" "http://localhost:5173"
  timeout /t 3 /nobreak >nul
  exit /b 0
)

powershell -NoProfile -Command "$ports = (Get-NetTCPConnection -State Listen -LocalPort 3000,5173 -ErrorAction SilentlyContinue).LocalPort; if ($ports.Count -gt 0) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo ERROR: el puerto 3000 o 5173 esta ocupado por otra version.
  echo Cierra la consola anterior con Ctrl+C y vuelve a intentarlo.
  timeout /t 8 /nobreak >nul
  exit /b 1
)

findstr /B /C:"MONGODB_URI=mongodb://" /C:"MONGODB_URI=mongodb+srv://" "API\.env" >nul
if errorlevel 1 goto mongo_error
findstr /C:"USUARIO:" /C:"CONTRASENA@" /C:"@CLUSTER." "API\.env" >nul
if not errorlevel 1 goto mongo_error

if not exist "node_modules" (
  echo Instalando el iniciador unico...
  call npm install
  if errorlevel 1 exit /b 1
)
if not exist "API\node_modules" (
  echo Instalando API...
  call npm install --prefix API
  if errorlevel 1 exit /b 1
)
if not exist "APP\node_modules" (
  echo Instalando APP...
  call npm install --prefix APP
  if errorlevel 1 exit /b 1
)

echo.
echo APP: http://localhost:5173
echo API: http://localhost:3000
echo Para detener ambos servicios presiona Ctrl+C una sola vez.
echo.
call npm start
exit /b %ERRORLEVEL%

:mongo_error
echo ERROR: configura tu cadena real de MongoDB Atlas en API\.env
echo Debe comenzar con MONGODB_URI=mongodb+srv:// y no contener marcadores.
start "" notepad "%~dp0API\.env"
timeout /t 8 /nobreak >nul
exit /b 1
