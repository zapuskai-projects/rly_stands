@echo off
setlocal

set "KIT_DIR=%~dp0"
if "%KIT_DIR:~-1%"=="\" set "KIT_DIR=%KIT_DIR:~0,-1%"
set "KIT_HOST_DIR=%KIT_DIR:\=/%"
set /p VERSION=<"%KIT_DIR%\VERSION"
if not defined STAND_PULT_IMAGE set "STAND_PULT_IMAGE=ghcr.io/zapuskai-projects/stands-kit-pult:%VERSION%"
if not defined STAND_PLATFORM_URL set "STAND_PLATFORM_URL=https://api.education.zapuskai.com"

where docker >nul 2>&1
if errorlevel 1 (
  echo Docker не найден. Установите Docker Desktop: https://www.docker.com/products/docker-desktop/ 1>&2
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker не запущен. Откройте Docker Desktop, дождитесь статуса Running и повторите команду. 1>&2
  exit /b 1
)

docker network inspect stands-kit >nul 2>&1 || docker network create stands-kit >nul

docker run --rm -it ^
  --network stands-kit ^
  --add-host host.docker.internal:host-gateway ^
  -v //var/run/docker.sock:/var/run/docker.sock ^
  -v stands-kit-data:/data ^
  -v "%KIT_DIR%":/kit ^
  -w /kit ^
  -e KIT_HOST_DIR="%KIT_HOST_DIR%" ^
  -e KIT_VERSION="%VERSION%" ^
  -e STAND_PLATFORM_URL ^
  -e STAND_MIRROR ^
  -e STAND_PULT_IMAGE ^
  -e STAND_LINUX_IMAGE ^
  -e STAND_BANK_IMAGE ^
  -e KIT_AGENT_INTERVAL_SEC ^
  -e STAND_MEMORY_TOTAL_MB ^
  %STAND_PULT_IMAGE% %*
exit /b %ERRORLEVEL%
