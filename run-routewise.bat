@echo off
cd /d "%~dp0"
where java >nul 2>nul
if errorlevel 1 (
  echo Java 17 or newer is required. Install Java, then run this file again.
  pause
  exit /b 1
)
start "RouteWise Server" /min /D "%~dp0" cmd /k java src/main/java/app/RouteOptimizerServer.java
for /L %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8080/' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto :ready
  timeout /t 1 /nobreak >nul
)
echo RouteWise did not respond on port 8080. Check the minimized Java server window for its error.
pause
exit /b 1
:ready
start "" "http://localhost:8080/"
