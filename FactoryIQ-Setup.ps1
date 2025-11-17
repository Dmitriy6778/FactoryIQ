# FactoryIQ-Setup.ps1  (PowerShell 5.1 / ASCII only)
# Bootstrap: Caddy (HTTPS, reverse proxy) + build frontend + deploy backend + Windows services (NSSM)

param(
  [string]$HostName    = 'factoryiq.local',
  [int]   $UvicornPort = 8000,
  

  # Paths
  [string]$ProdRoot  = 'C:\inetpub\FactoryIQ',
  [string]$FrontProd = 'C:\inetpub\FactoryIQ\frontend_dist',
  [string]$BackProd  = 'C:\inetpub\FactoryIQ\backend',

  # Dev sources on this machine
  [string]$FrontDev  = "$PSScriptRoot\frontend\FactoryIQ-UI",
  [string]$BackDev   = "$PSScriptRoot\backend",

  # Python venv
  [string]$VenvPython = 'C:\inetpub\FactoryIQ\backend\venv\Scripts\python.exe',

  # Caddy
  [string]$CaddyExe   = 'C:\Caddy\caddy.exe',
  [string]$CaddyDir   = 'C:\Caddy',
  [string]$Caddyfile  = 'C:\Caddy\Caddyfile',
  [string]$SvcCaddy   = 'factoryiq-caddy',

  # Service names
  [string]$SvcApi   = 'factoryiq-api',
  [string]$SvcOpc   = 'factoryiq-opc',
  [string]$SvcRpt   = 'factoryiq-reports',
  [string]$SvcWdg   = 'factoryiq-watchdog'   # NEW: watchdog service
)

$ErrorActionPreference = 'Stop'

function Ok   ($m){ Write-Host $m -ForegroundColor Green }
function Info ($m){ Write-Host $m -ForegroundColor Cyan }
function Warn ($m){ Write-Host $m -ForegroundColor Yellow }
function Fail ($m){ Write-Host $m -ForegroundColor Red; exit 1 }

function Get-CmdPath([string]$name){
  try { (Get-Command $name -ErrorAction Stop).Source } catch { $null }
}

# ---------------- 1) Tools (NSSM, Node) ----------------
function Do-InstallTools {
  $nssm = Get-CmdPath 'nssm'
  if ($nssm) { Ok ("NSSM found: {0}" -f $nssm) }
  else {
    $choco = Get-CmdPath 'choco'
    if ($choco) {
      Info 'Installing NSSM via Chocolatey...'
      choco install nssm -y | Out-Null
      $nssm = Get-CmdPath 'nssm'
      if ($nssm) { Ok ("NSSM installed: {0}" -f $nssm) } else { Fail 'NSSM not found after choco. Install manually and re-run.' }
    } else {
      Fail 'Chocolatey not found. Install NSSM manually (put nssm.exe into PATH) and re-run.'
    }
  }
  try { $nodev = node -v; Ok ("Node.js: {0}" -f $nodev) } catch { Warn 'Node.js not found. Install Node LTS for frontend build.' }
}

# ---------------- helpers ----------------
function Ensure-Folders-And-Hosts {
  New-Item -ItemType Directory -Force -Path $ProdRoot,$FrontProd,$BackProd | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ProdRoot 'tooling') | Out-Null
  $hosts = "$env:windir\System32\drivers\etc\hosts"
  $line  = ("127.0.0.1`t{0}" -f $HostName)
  $hostsText = (Get-Content $hosts -ErrorAction SilentlyContinue) -join "`n"
  if ($hostsText -notmatch [regex]::Escape($HostName)) {
    Add-Content -Path $hosts -Value $line
    Ok ("Added hosts entry: {0}" -f $line)
  } else { Info 'Hosts already contains the hostname.' }
}

function Write-Caddyfile {
  param([string]$HostName,[int]$UvicornPort,[string]$FrontRoot)

"$($HostName):443 {
    encode zstd gzip
    tls internal

    @api path /api*
    handle @api {
        uri strip_prefix /api
        reverse_proxy 127.0.0.1:$UvicornPort {
            header_up Host {host}
            header_up X-Forwarded-Proto https
        }
    }

    @direct path /openapi.json /docs* /redoc* /auth/* /users/* /servers/* /tags/* /reports/* /notifications/* /system/* /opctags/*
    handle @direct {
        reverse_proxy 127.0.0.1:$UvicornPort
    }

    handle {
        root * $FrontRoot
        try_files {path} /index.html
        file_server
    }

    log {
        output file $env:ProgramData\FactoryIQ\logs\caddy.access.log
        format console
    }

    
" | Set-Content -Path $Caddyfile -Encoding ascii -Force
  Ok "Caddyfile written: $Caddyfile"
}

function Remove-Service-Force([string]$Name){
  try { sc.exe stop $Name | Out-Null } catch {}
  Start-Sleep -Seconds 2
  try {
    $svc = Get-CimInstance win32_service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if ($svc -and $svc.ProcessId -gt 0) { taskkill /PID $($svc.ProcessId) /T /F | Out-Null }
  } catch {}
  try { sc.exe delete $Name | Out-Null } catch {}
}

function Get-ProcByPort([int]$Port){
  (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Group-Object OwningProcess | ForEach-Object {
      $_.Group | Select-Object -First 1 | ForEach-Object {
        [PSCustomObject]@{
          PID       = $_.OwningProcess
          Process   = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name
          LocalPort = $_.LocalPort
        }
      }
  })
}

# ---------------- 2) Build & deploy FRONTEND ----------------
function Step-FrontendBuildAndDeploy {
  param(
    [string]$DevClient   = $FrontDev,
    [string]$ProdWebRoot = $FrontProd
  )

  Write-Host "=== FRONTEND: build & deploy (dev mode) ===" -ForegroundColor Green
  if (-not (Test-Path -Path $DevClient)) {
    throw ("Frontend folder not found: {0}" -f $DevClient)
  }

  if (-not (Test-Path $ProdWebRoot)) {
    New-Item -ItemType Directory -Path $ProdWebRoot | Out-Null
  }

  Push-Location $DevClient
  try {
    $nodeVer = (node -v) 2>$null
    $npmVer  = (npm -v)  2>$null
    if (-not $nodeVer -or -not $npmVer) { throw "Node.js / npm not found in PATH" }
    Write-Host ("node: {0}, npm: {1}" -f $nodeVer, $npmVer)

    $needInstall = -not (Test-Path "$DevClient\node_modules")
    if ($needInstall) {
      Write-Host "node_modules not found → npm install (with devDependencies)" -ForegroundColor Yellow
      $oldNodeEnv = $env:NODE_ENV
      $oldNpmProd = $env:NPM_CONFIG_PRODUCTION
      $env:NODE_ENV = 'development'
      $env:NPM_CONFIG_PRODUCTION = 'false'
      try { npm install --no-audit --no-fund } finally {
        if ($null -ne $oldNodeEnv) { $env:NODE_ENV = $oldNodeEnv } else { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }
        if ($null -ne $oldNpmProd) { $env:NPM_CONFIG_PRODUCTION = $oldNpmProd } else { Remove-Item Env:NPM_CONFIG_PRODUCTION -ErrorAction SilentlyContinue }
      }
    } else {
      Write-Host "node_modules present → skipping npm install" -ForegroundColor Cyan
    }

    $oldNodeEnvBuild = $env:NODE_ENV
    $env:NODE_ENV = 'development'
    try { npm run build -- --mode development } finally {
      if ($null -ne $oldNodeEnvBuild) { $env:NODE_ENV = $oldNodeEnvBuild } else { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }
    }

    $dist      = Join-Path $DevClient "dist"
    $distIndex = Join-Path $dist "index.html"
    if (-not (Test-Path $distIndex)) { throw ("Build artifact not found: {0}" -f $distIndex) }

    $ts        = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupDir = Join-Path (Split-Path $ProdWebRoot -Parent) ("front_backup_" + $ts)
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    robocopy $ProdWebRoot $backupDir /E /XF web.config 1>$null 2>$null | Out-Null

    robocopy $dist $ProdWebRoot /MIR /XF web.config /R:2 /W:2 | Out-Null

    $health = Join-Path $ProdWebRoot "health.txt"
    if (-not (Test-Path $health)) { Set-Content -Path $health -Value "OK" -Encoding ascii }

    $prodIndex = Join-Path $ProdWebRoot "index.html"
    if (-not (Test-Path $prodIndex)) { throw ("Deployed index.html missing at {0}" -f $prodIndex) }

    Write-Host "OK: frontend built (dev mode) and deployed to $ProdWebRoot" -ForegroundColor Green
  }
  finally { Pop-Location }
}

# ---------------- 3) Deploy BACKEND (venv + requirements) ----------------
function Do-DeployBackend {
  if (-not (Test-Path $BackDev)) { Warn ("Backend sources not found: {0}" -f $BackDev); return }
  New-Item -ItemType Directory -Force -Path $BackProd | Out-Null
  robocopy $BackDev $BackProd /MIR /XD venv __pycache__ .git .mypy_cache .pytest_cache /XF *.log *.pyc /R:2 /W:1 | Out-Null

  if (-not (Test-Path $VenvPython)) {
    Info 'Creating venv...'
    $sysPy = Get-CmdPath 'python'
    if (-not $sysPy) { Fail 'No system python found to create venv.' }
    Push-Location $BackProd
    try { & $sysPy -m venv venv } finally { Pop-Location }
  }
  $req = Join-Path $BackProd 'requirements.txt'
  if (Test-Path $req) { & $VenvPython -m pip install -r $req }
  else { & $VenvPython -m pip install -U fastapi "uvicorn[standard]" }

  New-Item -ItemType File -Force -Path (Join-Path $BackProd 'app\__init__.py') | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $BackProd 'app\routers\__init__.py') | Out-Null
  Ok ("Backend deployed to {0}" -f $BackProd)
}

# ---------------- WATCHDOG writer (creates tooling\watchdog_worker.ps1) ----------------
function Write-WatchdogScript {
  $tooling = Join-Path $ProdRoot 'tooling'
  New-Item -ItemType Directory -Force -Path $tooling | Out-Null
  $wdgPath = Join-Path $tooling 'watchdog_worker.ps1'

@'
param(
  [int]$StaleMinutes = 10,
  [string]$SqlServer = "localhost",
  [string]$Database  = "OpcUaSystem",
  [string]$User      = "tg_user",
  [string]$Password  = "mnemic6778",
  [string]$Service   = "factoryiq-opc",
  [int]$LoopSec      = 180
)
$ErrorActionPreference = "Stop"

function Test-Ingest {
  $cn  = New-Object System.Data.SqlClient.SqlConnection
  $cn.ConnectionString = "Server=$SqlServer;Database=$Database;User ID=$User;Password=$Password;TrustServerCertificate=Yes;Encrypt=Yes;Application Name=FactoryIQ-Watchdog"
  $cn.Open()
  $cmd = $cn.CreateCommand()
  $cmd.CommandText = "SELECT DATEDIFF(MINUTE, MAX([Timestamp]), SYSUTCDATETIME()) FROM dbo.OpcData WITH (READUNCOMMITTED)"
  $minutes = [int]$cmd.ExecuteScalar()
  $cn.Close()
  return $minutes
}

while ($true) {
  try {
    $m = Test-Ingest
    if ($m -ge $StaleMinutes) {
      Write-Host ("Ingest stale: {0} min >= {1} -> restarting {2}" -f $m,$StaleMinutes,$Service)
      try { & nssm stop  $Service | Out-Null } catch {}
      Start-Sleep -Seconds 2
      try { & nssm start $Service | Out-Null } catch {
        try {
          $svc = Get-Service -Name $Service -ErrorAction Stop
          if ($svc.Status -eq "Running") { Restart-Service -Name $Service -Force -ErrorAction Stop }
          else { Start-Service -Name $Service -ErrorAction Stop }
        } catch {}
      }
    } else {
      Write-Host ("Ingest OK: last write {0} min ago (< {1})" -f $m,$StaleMinutes)
    }
  } catch {
    Write-Host ("Watchdog error: {0}" -f $_.Exception.Message)
  }
  Start-Sleep -Seconds $LoopSec
}
'@ | Set-Content -Path $wdgPath -Encoding ascii -Force

  Ok ("Watchdog script written: {0}" -f $wdgPath)
  return $wdgPath
}

# ---------------- 4) Register Windows Services (API / OPC / Reports / Caddy / Watchdog) ----------------
function Do-Services {
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
  if (-not $nssm) { Fail 'NSSM not found. Run menu item 1 first.' }
  if (-not (Test-Path $VenvPython)) { Fail ("Venv python not found: {0}. Run backend deploy first." -f $VenvPython) }

  # Logs
  $logs = Join-Path $ProdRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $fiqData = Join-Path $env:ProgramData 'FactoryIQ'
  New-Item -ItemType Directory -Force -Path (Join-Path $fiqData 'logs') | Out-Null

  $FERNET = 'Z3Vls19NlJWSwECAQF7vxEBStOvACn97aPS9fjPileQ='

  # API (uvicorn)
  $uviex = Join-Path (Split-Path $VenvPython -Parent) 'uvicorn.exe'
  if (-not (Test-Path $uviex)) {
    & $VenvPython -m pip install -U "uvicorn[standard]" | Out-Null
    $uviex = Join-Path (Split-Path $VenvPython -Parent) 'uvicorn.exe'
  }
  Remove-Service-Force -Name $SvcApi
  & nssm install $SvcApi $uviex "app.main:app --host 127.0.0.1 --port $UvicornPort --workers 1 --proxy-headers --forwarded-allow-ips 127.0.0.1" | Out-Null
  & nssm set $SvcApi AppDirectory $BackProd | Out-Null
  & nssm set $SvcApi AppStdout (Join-Path $logs 'api.out.log') | Out-Null
  & nssm set $SvcApi AppStderr (Join-Path $logs 'api.err.log') | Out-Null
  & nssm set $SvcApi AppRotateFiles 1 | Out-Null
  & nssm set $SvcApi AppRotateOnline 1 | Out-Null
  & nssm set $SvcApi AppRotateBytes 10485760 | Out-Null
  & nssm set $SvcApi AppEnvironmentExtra ("PYTHONUNBUFFERED=1","PYTHONPATH=$BackProd") | Out-Null
  & nssm set $SvcApi Start SERVICE_AUTO_START | Out-Null
  & nssm start $SvcApi | Out-Null
  Ok 'Service ready: factoryiq-api'

  # OPC worker
  Remove-Service-Force -Name $SvcOpc
  & nssm install $SvcOpc $VenvPython 'app\opc_polling_worker_sync.py' | Out-Null
  & nssm set $SvcOpc AppDirectory $BackProd | Out-Null
  & nssm set $SvcOpc AppStdout (Join-Path $logs 'opc.out.log') | Out-Null
  & nssm set $SvcOpc AppStderr (Join-Path $logs 'opc.err.log') | Out-Null
  & nssm set $SvcOpc AppRotateFiles 1 | Out-Null
  & nssm set $SvcOpc AppRotateOnline 1 | Out-Null
  & nssm set $SvcOpc AppRotateBytes 10485760 | Out-Null
  & nssm set $SvcOpc AppEnvironmentExtra ("PYTHONUNBUFFERED=1","PYTHONPATH=$BackProd","FERNET_KEY=$FERNET") | Out-Null
  & nssm set $SvcOpc Start SERVICE_AUTO_START | Out-Null
  & nssm start $SvcOpc | Out-Null
  Ok 'Service ready: factoryiq-opc'

  # Reports worker
  Remove-Service-Force -Name $SvcRpt
  & nssm install $SvcRpt $VenvPython 'app\report_worker.py' | Out-Null
  & nssm set $SvcRpt AppDirectory $BackProd | Out-Null
  & nssm set $SvcRpt AppStdout (Join-Path $logs 'reports.out.log') | Out-Null
  & nssm set $SvcRpt AppStderr (Join-Path $logs 'reports.err.log') | Out-Null
  & nssm set $SvcRpt AppRotateFiles 1 | Out-Null
  & nssm set $SvcRpt AppRotateOnline 1 | Out-Null
  & nssm set $SvcRpt AppRotateBytes 10485760 | Out-Null
  & nssm set $SvcRpt AppEnvironmentExtra ("PYTHONUNBUFFERED=1","PYTHONPATH=$BackProd","FERNET_KEY=$FERNET") | Out-Null
  & nssm set $SvcRpt Start SERVICE_AUTO_START | Out-Null
  & nssm start $SvcRpt | Out-Null
  Ok 'Service ready: factoryiq-reports'

# --- CADDYFILE: не перезаписываем, если уже есть и Preserve включен ---

# Порт 443 свободен?
$p443 = Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p443) { Warn ("Port 443 is already in use by PID={0}." -f $p443.OwningProcess) }

# Чистая регистрация службы
try { sc.exe stop   $SvcCaddy | Out-Null } catch {}
Start-Sleep -Seconds 2
try { sc.exe delete $SvcCaddy | Out-Null } catch {}

$fiqData   = Join-Path $env:ProgramData 'FactoryIQ'
New-Item -ItemType Directory -Force -Path (Join-Path $fiqData 'logs') | Out-Null

# Важно: РОВНО эта строка параметров (как в «старой рабочей» версии)
& nssm install $SvcCaddy $CaddyExe "run --config `"$Caddyfile`" --adapter caddyfile" | Out-Null
& nssm set     $SvcCaddy AppDirectory $CaddyDir | Out-Null
& nssm set     $SvcCaddy AppStdout    (Join-Path $fiqData 'logs\caddy.out.log') | Out-Null
& nssm set     $SvcCaddy AppStderr    (Join-Path $fiqData 'logs\caddy.err.log') | Out-Null
& nssm set     $SvcCaddy AppRotateFiles 1 | Out-Null
& nssm set     $SvcCaddy AppRotateOnline 1 | Out-Null
& nssm set     $SvcCaddy AppRotateBytes 10485760 | Out-Null

# Анти-pause/троттлинг — проверенные настройки для NSSM
& nssm set     $SvcCaddy AppNoConsole         1 | Out-Null
& nssm set     $SvcCaddy AppStopMethodConsole 0 | Out-Null
& nssm set     $SvcCaddy AppStopMethodWindow  0 | Out-Null
& nssm set     $SvcCaddy AppStopMethodThreads 0 | Out-Null
& nssm set     $SvcCaddy AppKillProcessTree   1 | Out-Null
& nssm set     $SvcCaddy AppExit Default      Restart | Out-Null
& nssm set     $SvcCaddy AppRestartDelay      5000 | Out-Null
& nssm set     $SvcCaddy AppThrottle          0 | Out-Null

& nssm set     $SvcCaddy Start SERVICE_AUTO_START | Out-Null
& nssm start   $SvcCaddy | Out-Null
Ok "Service ready: $SvcCaddy"


  # WATCHDOG (NEW)
  $wdgPath = Write-WatchdogScript
  $psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  Remove-Service-Force -Name $SvcWdg
  & nssm install $SvcWdg $psExe "-NoProfile -ExecutionPolicy Bypass -File `"$wdgPath`" -StaleMinutes 10 -SqlServer localhost -Database OpcUaSystem -User tg_user -Password mnemic6778 -Service $SvcOpc -LoopSec 180" | Out-Null
  & nssm set $SvcWdg AppDirectory (Split-Path $wdgPath -Parent) | Out-Null
  & nssm set $SvcWdg AppStdout (Join-Path $logs 'watchdog.out.log') | Out-Null
  & nssm set $SvcWdg AppStderr (Join-Path $logs 'watchdog.err.log') | Out-Null
  & nssm set $SvcWdg AppRotateFiles 1 | Out-Null
  & nssm set $SvcWdg AppRotateOnline 1 | Out-Null
  & nssm set $SvcWdg AppRotateBytes 10485760 | Out-Null
  & nssm set $SvcWdg Start SERVICE_AUTO_START | Out-Null
  & nssm start $SvcWdg | Out-Null

  Ok 'Service ready: factoryiq-watchdog'

  Get-Service $SvcApi,$SvcOpc,$SvcRpt,$SvcWdg | Select Name,Status,StartType | Format-Table -AutoSize
  Get-Service $SvcCaddy | Select Name,Status,StartType | Format-Table -AutoSize
}

# ---------------- 5) Verify ----------------
function Do-Verify {
  Info 'Local API check:'
  try { & curl.exe ("http://127.0.0.1:{0}/openapi.json" -f $UvicornPort) } catch { Warn 'curl local API failed' }

  Info 'Caddy HTTPS check (root openapi):'
  try { & curl.exe --ssl-no-revoke -k "https://$HostName/openapi.json" } catch { Warn 'curl https root failed' }

  Info 'Caddy HTTPS check (API via /api):'
  try { & curl.exe --ssl-no-revoke -k "https://$HostName/api/openapi.json" } catch { Warn 'curl https api failed' }

  $p = Get-ProcByPort -Port $UvicornPort
  if ($p) { Ok ("Uvicorn listening on {0}: PID={1} ({2})" -f $UvicornPort, $p.PID, $p.Process) }
  else { Warn "Uvicorn not listening on $($UvicornPort)" }
}

# ---------------- 6) Repair ----------------
function Do-Repair {
  Info '=== REPAIR: restart services and quick checks ==='
  foreach($n in @($SvcApi,$SvcOpc,$SvcRpt,$SvcCaddy,$SvcWdg)){
    try { sc.exe stop $n | Out-Null } catch {}
  }
  Start-Sleep -Seconds 3
  foreach($n in @($SvcApi,$SvcOpc,$SvcRpt,$SvcCaddy,$SvcWdg)){
    try { sc.exe start $n | Out-Null } catch {}
  }
  Start-Sleep -Seconds 2
  Do-Verify
}

# ---------------- Menu ----------------
function Show-Menu {
  Write-Host ''
  Write-Host '===== FactoryIQ Setup (Caddy-only) =====' -ForegroundColor Magenta
  Write-Host '[1] Install tools (NSSM, Node check)'
  Write-Host '[2] Prepare folders + hosts record'
  Write-Host '[3] Build and deploy FRONTEND'
  Write-Host '[4] Deploy BACKEND (venv + requirements)'
  Write-Host '[5] Register Windows Services (API / OPC / Reports / Caddy / Watchdog)'
  Write-Host '[6] Verify (curl checks)'
  Write-Host '[7] Repair (restart services + verify)'
  Write-Host '[0] Exit'
  Write-Host '========================================'
}

do {
  Show-Menu
  $choice = Read-Host 'Select [0-7]'
  try {
    switch ($choice) {
      '1' { Do-InstallTools }
      '2' { Ensure-Folders-And-Hosts }
      '3' { Step-FrontendBuildAndDeploy -DevClient $FrontDev -ProdWebRoot $FrontProd }
      '4' { Do-DeployBackend }
      '5' { Do-Services }
      '6' { Do-Verify }
      '7' { Do-Repair }
      '0' { break }
      default { Write-Host 'Unknown choice' -ForegroundColor Yellow }
    }
  } catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
  }
  if ($choice -ne '0') { Write-Host ''; Read-Host 'Press Enter to continue...' | Out-Null }
} while ($true)
