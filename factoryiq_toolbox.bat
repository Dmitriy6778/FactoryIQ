@echo off
setlocal EnableExtensions EnableDelayedExpansion
title IAS ALTYNALMAS - TOOLBOX (SAFE ASCII v3)
color 0A

REM -------- Paths (EDIT) --------
set "DEV_ROOT=D:\My_Business\AltaiMai\FactoryIQ"
set "FRONT_DEV=%DEV_ROOT%\frontend\FactoryIQ-UI"
set "BACK_DEV=%DEV_ROOT%\backend"

set "PROD_ROOT=C:\inetpub\FactoryIQ"
set "FRONT_PROD=%PROD_ROOT%\frontend_dist"
set "BACK_PROD=%PROD_ROOT%\backend"
set "BACKUP_DIR=%PROD_ROOT%\_backup"

set "APPCMD=%windir%\System32\inetsrv\appcmd.exe"

REM IIS site/app-pools
set "SITE_NAME=FactoryIQ.local"
set "WEB_POOL=IASWebPool"
set "API_POOL=IASApiPool"

REM HTTPS
set "HOSTNAME=FactoryIQ.local"
set "HTTPS_PORT=443"

:MENU
cls
echo ===== IAS ALTYNALMAS TOOLBOX (v3) =====
echo [1] Deploy ALL (frontend+backend with backups)
echo [2] Frontend only (build and copy)
echo [3] Backend only (copy)
echo [4] Environment check
echo [5] IIS control
echo [6] Create HTTPS cert ^& bind to site
echo [7] Write backend web.config (Flask via wfastcgi)
echo [8] Write backend web.config (Reverse proxy http://127.0.0.1:8000)
echo [9] Exit
echo =======================================
choice /C 123456789 /N /M "Select [1-9]: "
set "opt=%errorlevel%"
if "%opt%"=="1" goto DEPLOY_ALL
if "%opt%"=="2" goto DEPLOY_FRONT
if "%opt%"=="3" goto DEPLOY_BACK
if "%opt%"=="4" goto ENV_CHECK
if "%opt%"=="5" goto IIS_CTRL
if "%opt%"=="6" goto SSL_CERT
if "%opt%"=="7" goto BACKEND_WEBCONFIG_FLASK
if "%opt%"=="8" goto BACKEND_WEBCONFIG_PROXY
goto END

:DEPLOY_ALL
call :DEPLOY_FRONT || goto AFTER_TASK
call :DEPLOY_BACK
goto AFTER_TASK

:DEPLOY_FRONT
echo === FRONTEND ===
if not exist "%FRONT_DEV%\package.json" ( echo ERROR: package.json not found & exit /b 1 )
pushd "%FRONT_DEV%"
node -v || (echo ERROR: Node not found & popd & exit /b 1)
call npm -v  || (echo ERROR: NPM not found & popd & exit /b 1)
if exist "%FRONT_DEV%\package-lock.json" (
  call npm ci || (echo ERROR: npm ci failed & popd & exit /b 1)
) else (
  call npm install || (echo ERROR: npm install failed & popd & exit /b 1)
)
call npm run build || (echo ERROR: npm run build failed & popd & exit /b 1)
popd
if not exist "%PROD_ROOT%" mkdir "%PROD_ROOT%"
if not exist "%FRONT_PROD%" mkdir "%FRONT_PROD%"
set "TS=%date:~-4%%date:~3,2%%date:~0,2%_%time:~0,2%%time:~3,2%%time:~6,2%"
set "TS=%TS: =0%"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
if exist "%FRONT_PROD%\index.html" (
  echo Backup old frontend...
  xcopy /E /I /Y "%FRONT_PROD%" "%BACKUP_DIR%\frontend_%TS%" >nul
)
echo Copying dist -> PROD ...
robocopy "%FRONT_DEV%\dist" "%FRONT_PROD%" /MIR /R:2 /W:1
if not exist "%FRONT_PROD%\web.config" call :WRITE_FRONT_WEBCONFIG "%FRONT_PROD%\web.config"
echo OK: Frontend deployed
exit /b 0

:DEPLOY_BACK
echo === BACKEND ===
if not exist "%BACK_DEV%\app" ( echo ERROR: backend app folder not found & exit /b 1 )
if not exist "%PROD_ROOT%" mkdir "%PROD_ROOT%"
if not exist "%BACK_PROD%" mkdir "%BACK_PROD%"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
set "TS=%date:~-4%%date:~3,2%%date:~0,2%_%time:~0,2%%time:~3,2%%time:~6,2%"
set "TS=%TS: =0%"
if exist "%BACK_PROD%\app" (
  echo Backup old backend...
  xcopy /E /I /Y "%BACK_PROD%" "%BACKUP_DIR%\backend_%TS%" >nul
)
if exist "%APPCMD%" "%APPCMD%" list apppool "%API_POOL%" >nul 2>&1 && "%APPCMD%" stop apppool /apppool.name:"%API_POOL%" >nul
robocopy "%BACK_DEV%" "%BACK_PROD%" /MIR /XD venv __pycache__ .git .mypy_cache .pytest_cache /XF *.log *.pyc /R:2 /W:1
if exist "%APPCMD%" "%APPCMD%" list apppool "%API_POOL%" >nul 2>&1 && "%APPCMD%" start apppool /apppool.name:"%API_POOL%" >nul
echo OK: Backend deployed
exit /b 0

:ENV_CHECK
echo DEV_ROOT   = %DEV_ROOT%
echo FRONT_DEV  = %FRONT_DEV%
echo BACK_DEV   = %BACK_DEV%
echo PROD_ROOT  = %PROD_ROOT%
echo FRONT_PROD = %FRONT_PROD%
echo BACK_PROD  = %BACK_PROD%
echo BACKUP_DIR = %BACKUP_DIR%
echo APPCMD     = %APPCMD%
echo SITE_NAME  = %SITE_NAME%
echo WEB_POOL   = %WEB_POOL%
echo API_POOL   = %API_POOL%
echo HOSTNAME   = %HOSTNAME%
echo HTTPS_PORT = %HTTPS_PORT%
echo.
node -v || echo Node: NOT FOUND
call npm -v  || echo NPM : NOT FOUND
python --version || echo Python: NOT FOUND
if exist "%APPCMD%" (
  echo ---- IIS Sites ----
  "%APPCMD%" list site
  echo ---- IIS AppPools ----
  "%APPCMD%" list apppool
) else (
  echo IIS appcmd.exe NOT FOUND
)
goto AFTER_TASK

:IIS_CTRL
echo [1] Recycle web pool
echo [2] Recycle api pool
echo [3] Restart site
echo [4] Back
choice /C 1234 /N /M "Select [1-4]: "
set "iopt=%errorlevel%"
if "%iopt%"=="1" if exist "%APPCMD%" "%APPCMD%" recycle apppool /apppool.name:"%WEB_POOL%"
if "%iopt%"=="2" if exist "%APPCMD%" "%APPCMD%" recycle apppool /apppool.name:"%API_POOL%"
if "%iopt%"=="3" if exist "%APPCMD%" "%APPCMD%" stop site /site.name:"%SITE_NAME%" & if exist "%APPCMD%" "%APPCMD%" start site /site.name:"%SITE_NAME%"
goto AFTER_TASK

:SSL_CERT
echo === Create self-signed cert and bind HTTPS ===

REM sane defaults if somehow empty
if "%SITE_NAME%"==""   set "SITE_NAME=FactoryIQ.local"
if "%HOSTNAME%"==""    set "HOSTNAME=%SITE_NAME%"
if "%HTTPS_PORT%"==""  set "HTTPS_PORT=443"

echo Site: %SITE_NAME%  Hostname: %HOSTNAME%  Port: %HTTPS_PORT%

powershell -NoProfile -ExecutionPolicy Bypass -Command "Import-Module WebAdministration; $cn='%HOSTNAME%'; $site='%SITE_NAME%'; $port=%HTTPS_PORT%; $ip='0.0.0.0'; $cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -eq ('CN=' + $cn) } | Select-Object -First 1; if (-not $cert) { $cert = New-SelfSignedCertificate -DnsName $cn -CertStoreLocation 'Cert:\LocalMachine\My' }; $thumb = $cert.Thumbprint; Write-Host ('Thumbprint: ' + $thumb); $existing = Get-WebBinding -Name $site -Protocol https -ErrorAction SilentlyContinue | Where-Object { $_.bindingInformation -like ('*:' + $port + ':' + $cn) }; if ($existing) { Remove-WebBinding -Name $site -Protocol https -Port $port -HostHeader $cn -ErrorAction SilentlyContinue }; New-WebBinding -Name $site -Protocol https -Port $port -HostHeader $cn | Out-Null; Push-Location IIS:\SslBindings; $bang=[char]33; $bindingPath = $ip + $bang + $port + $bang + $cn; if (Test-Path $bindingPath) { Remove-Item $bindingPath -ErrorAction SilentlyContinue }; New-Item $bindingPath -Thumbprint $thumb -SSLFlags 1 | Out-Null; Pop-Location; Write-Host ('HTTPS binding updated: ' + $bindingPath)"

goto AFTER_TASK



:BACKEND_WEBCONFIG_FLASK
echo === Write backend web.config (Flask + wfastcgi) ===
if not exist "%BACK_PROD%" mkdir "%BACK_PROD%"
call :WRITE_BACK_WEBCONFIG_FLASK "%BACK_PROD%\web.config"
echo Wrote %BACK_PROD%\web.config
echo NOTE: Ensure your Flask WSGI callable and paths below are correct.
goto AFTER_TASK

:BACKEND_WEBCONFIG_PROXY
echo === Write backend web.config (Reverse proxy -> http://127.0.0.1:8000) ===
echo This requires IIS ARR + URL Rewrite installed.
if not exist "%BACK_PROD%" mkdir "%BACK_PROD%"
call :WRITE_BACK_WEBCONFIG_PROXY "%BACK_PROD%\web.config"
echo Wrote %BACK_PROD%\web.config
goto AFTER_TASK

:WRITE_FRONT_WEBCONFIG
set "CFG=%~1"
(
  echo ^<?xml version="1.0" encoding="utf-8"?^>
  echo ^<configuration^>
  echo   ^<system.webServer^>
  echo     ^<staticContent^>
  echo       ^<remove fileExtension=".json" /^>
  echo       ^<remove fileExtension=".webp" /^>
  echo       ^<remove fileExtension=".woff2" /^>
  echo       ^<remove fileExtension=".svg" /^>
  echo       ^<mimeMap fileExtension=".json"  mimeType="application/json" /^>
  echo       ^<mimeMap fileExtension=".webp"  mimeType="image/webp" /^>
  echo       ^<mimeMap fileExtension=".woff2" mimeType="font/woff2" /^>
  echo       ^<mimeMap fileExtension=".svg"   mimeType="image/svg+xml" /^>
  echo     ^</staticContent^>
  echo     ^<rewrite^>
  echo       ^<rules^>
  echo         ^<rule name="SPA Fallback" stopProcessing="true"^>
  echo           ^<match url=".*" /^>
  echo           ^<conditions logicalGrouping="MatchAll" trackAllCaptures="false"^>
  echo             ^<add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" /^>
  echo             ^<add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" /^>
  echo           ^</conditions^>
  echo           ^<action type="Rewrite" url="/index.html" /^>
  echo         ^</rule^>
  echo       ^</rules^>
  echo     ^</rewrite^>
  echo   ^</system.webServer^>
  echo ^</configuration^>
)>"%CFG%"
exit /b 0

REM === Flask (WSGI via wfastcgi) web.config template ===
:WRITE_BACK_WEBCONFIG_FLASK
set "CFG=%~1"
(
  echo ^<?xml version="1.0" encoding="utf-8"?^>
  echo ^<configuration^>
  echo   ^<system.webServer^>
  echo     ^<handlers^>
  echo       ^<add name="PythonFastCGI" path="*" verb="*" modules="FastCgiModule" requireAccess="Script"
  echo            scriptProcessor="C:\inetpub\FactoryIQ\backend\venv\Scripts\python.exe^|C:\inetpub\FactoryIQ\backend\venv\Lib\site-packages\wfastcgi.py"
  echo            resourceType="Unspecified" /^>
  echo     ^</handlers^>
  echo     ^<httpErrors errorMode="Detailed" /^>
  echo     ^<asp scriptErrorSentToBrowser="true" /^>
  echo   ^</system.webServer^>
  echo   ^<appSettings^>
  echo     ^<!-- EDIT these two lines to your real Flask entrypoint --^>
  echo     ^<add key="WSGI_HANDLER" value="entrypoint:application" /^>
  echo     ^<add key="PYTHONPATH" value="C:\inetpub\FactoryIQ\backend" /^>
  echo     ^<add key="WSGI_LOG" value="C:\inetpub\FactoryIQ\backend\wfastcgi.log" /^>
  echo   ^</appSettings^>
  echo ^</configuration^>
)>"%CFG%"
exit /b 0

REM === Reverse proxy web.config (IIS ARR -> uvicorn 127.0.0.1:8000) ===
:WRITE_BACK_WEBCONFIG_PROXY
set "CFG=%~1"
(
  echo ^<?xml version="1.0" encoding="utf-8"?^>
  echo ^<configuration^>
  echo   ^<system.webServer^>
  echo     ^<handlers^>
  echo       ^<add name="StaticFile" path="*" verb="*" modules="StaticFileModule,DefaultDocumentModule" resourceType="Either" requireAccess="Read" /^>
  echo     ^</handlers^>
  echo     ^<rewrite^>
  echo       ^<rules^>
  echo         ^<rule name="ReverseProxyInbound" stopProcessing="true"^>
  echo           ^<match url="(.*)" /^>
  echo           ^<action type="Rewrite" url="http://127.0.0.1:8000/{R:1}" logRewrittenUrl="true" /^>
  echo         ^</rule^>
  echo       ^</rules^>
  echo     ^</rewrite^>
  echo   ^</system.webServer^>
  echo ^</configuration^>
)>"%CFG%"
exit /b 0

:AFTER_TASK
echo.
echo Press any key to return to menu...
pause >nul
goto MENU

:END
endlocal
exit /b 0
