# FactoryIQ setup with detailed logging (no file locking)
param(
  [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"

# ---------------- CONFIG ----------------
$ROOT         = "D:\My_Business\AltaiMai\FactoryIQ"
$FRONTEND_DIR = Join-Path $ROOT "frontend\FactoryIQ-UI"
$BACKEND_DIR  = Join-Path $ROOT "backend"
$APP_DIR      = Join-Path $BACKEND_DIR "app"
$VENV_DIR     = Join-Path $BACKEND_DIR "venv"

$PYTHON_EXE   = "python"
$UVICORN_APP  = "app.main:app"
$UVICORN_HOST = "127.0.0.1"
$UVICORN_PORT = 8000
$UVICORN_ARGS = "$UVICORN_APP --host $UVICORN_HOST --port $UVICORN_PORT"

# Services
$SVC_BACKEND  = "FactoryIQ_Backend"
$SVC_WORKER   = "FactoryIQ_Worker"
$SVC_CADDY    = "Caddy"

# Tools / paths
$TOOLS_DIR      = Join-Path $ROOT "tools"
$NSSM_DIR       = Join-Path $TOOLS_DIR "nssm"
$NSSM_EXE       = Join-Path $NSSM_DIR "nssm.exe"

$CADDYFILE_PATH = Join-Path $ROOT "Caddyfile"
$LOCAL_CADDY_EXE= Join-Path $ROOT "caddy_windows_amd64.exe"  # your local Caddy binary

# Logs (separate files for our logger and transcript!)
$LOG_DIR   = Join-Path $ROOT "logs"
$TS        = Get-Date -Format "yyyyMMdd_HHmmss"
$LOG_FILE  = Join-Path $LOG_DIR ("setup-{0}.log" -f $TS)
$TR_FILE   = Join-Path $LOG_DIR ("setup-{0}-transcript.log" -f $TS)

# --------------- LOGGING ---------------
function Ensure-Dir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null } }
Ensure-Dir $LOG_DIR

$global:STEP_NO = 0
function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -LiteralPath $LOG_FILE -Value $line -Encoding UTF8
}
function LogStep([string]$title) {
  $global:STEP_NO++
  Log ""
  Log ("==== [Step {0}] {1} ====" -f $global:STEP_NO, $title)
}
function LogOk()   { Log "OK" }
function LogWarn($m){ Log ("WARN: " + $m) }
function LogErr($m){ Log ("ERROR: " + $m) }

function Invoke-Safely([ScriptBlock]$Action, [string]$what) {
  Log ("-> " + $what)
  try {
    & $Action
    LogOk
  } catch {
    LogErr ("Failed: " + $what)
    LogErr $_.Exception.Message
    if ($_.ScriptStackTrace) { Log $_.ScriptStackTrace }
    throw
  }
}

# Start transcript to a DIFFERENT file to avoid locking the main log
try { Start-Transcript -Path $TR_FILE -Append | Out-Null } catch { LogWarn "Start-Transcript failed: $($_.Exception.Message)" }

# --------------- CHECKS ---------------
LogStep "Environment checks"
Invoke-Safely { if (-not (Test-Path $FRONTEND_DIR)) { throw "Frontend dir not found: $FRONTEND_DIR" } } "Check frontend dir"
Invoke-Safely { if (-not (Test-Path $APP_DIR))      { throw "Backend app dir not found: $APP_DIR" } } "Check backend app dir"

# ----------- PYTHON / VENV ------------
LogStep "Python venv and deps"
Invoke-Safely {
  Ensure-Dir $VENV_DIR
  if (-not (Test-Path (Join-Path $VENV_DIR "Scripts\python.exe"))) {
    & $PYTHON_EXE -m venv $VENV_DIR
    Log "Created venv: $VENV_DIR"
  } else {
    Log "Venv already exists"
  }
} "Create or reuse venv"

Invoke-Safely {
  & (Join-Path $VENV_DIR "Scripts\pip.exe") install -U pip wheel
  & (Join-Path $VENV_DIR "Scripts\pip.exe") install fastapi uvicorn[standard] pyodbc pandas matplotlib requests python-dotenv
} "Install/upgrade python packages"

# --------------- FRONTEND --------------
if (-not $SkipFrontendBuild) {
  LogStep "Frontend build"
  Invoke-Safely {
    Push-Location $FRONTEND_DIR
    try {
      $nv = node --version
      $pv = npm --version
      Log ("Node version: {0}" -f $nv)
      Log ("NPM version:  {0}" -f $pv)
    } catch { LogWarn "Node/NPM version check failed. Continue." }

    npm ci
    npm run build

    Pop-Location
  } "Build frontend"
} else {
  LogStep "Frontend build (skipped)"
  Log "SkipFrontendBuild = true"
}
$FRONT_DIST = Join-Path $FRONTEND_DIR "dist"
Invoke-Safely { if (-not (Test-Path $FRONT_DIST)) { throw "Front dist not found: $FRONT_DIST" } } "Check front dist exists"

# --------------- CADDYFILE -------------
LogStep "Caddy configure"
$caddyToUse = $null
if (Test-Path $LOCAL_CADDY_EXE) {
  $caddyToUse = $LOCAL_CADDY_EXE
  Log "Using local Caddy: $LOCAL_CADDY_EXE"
} else {
  LogErr "Caddy binary not found. Put caddy_windows_amd64.exe into $ROOT"
  throw "Caddy binary is missing"
}

$distPath = ($FRONT_DIST -replace '\\','/')
$apiPaths = @(
  "/telegram*", "/tg*", "/reports*", "/report-styles*", "/report-templates*",
  "/analytics*", "/db*", "/tags*", "/polling*", "/docs*", "/openapi.json"
)
$apiMatch = ($apiPaths -join " ")

$caddyLines = @()
$caddyLines += ":80 {"
$caddyLines += "    encode gzip"
$caddyLines += ("    root * {0}" -f $distPath)
$caddyLines += "    file_server"
$caddyLines += ""
$caddyLines += ("    @api path {0}" -f $apiMatch)
$caddyLines += ("    reverse_proxy @api http://127.0.0.1:{0}" -f $UVICORN_PORT)
$caddyLines += ""
$caddyLines += "    try_files {path} /index.html"
$caddyLines += ""
$caddyLines += "    log {"
$caddyLines += ("        output file {0}" -f (($ROOT -replace '\\','/') + "/logs/caddy-access.log"))
$caddyLines += "        level info"
$caddyLines += "    }"
$caddyLines += "}"

Invoke-Safely {
  Set-Content -LiteralPath $CADDYFILE_PATH -Value $caddyLines -Encoding UTF8
} "Write Caddyfile"

# --------------- FIREWALL --------------
LogStep "Open Windows Firewall port 80"
Invoke-Safely {
  $rule = Get-NetFirewallRule -DisplayName "Allow HTTP 80 FactoryIQ" -ErrorAction SilentlyContinue
  if (-not $rule) {
    New-NetFirewallRule -DisplayName "Allow HTTP 80 FactoryIQ" -Direction Inbound -LocalPort 80 -Protocol TCP -Action Allow | Out-Null
    Log "Firewall rule added"
  } else {
    Log "Firewall rule already exists"
  }
} "Ensure inbound rule for port 80"

# ---------------- NSSM -----------------
LogStep "Install or refresh services (NSSM)"
Invoke-Safely {
  Ensure-Dir $NSSM_DIR
  if (-not (Test-Path $NSSM_EXE)) {
    $zip = Join-Path $NSSM_DIR "nssm.zip"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $NSSM_DIR -Force
    $cand = Get-ChildItem -Path $NSSM_DIR -Recurse -Filter "nssm.exe" | Where-Object { $_.FullName -match "win64" } | Select-Object -First 1
    if (-not $cand) { $cand = Get-ChildItem -Path $NSSM_DIR -Recurse -Filter "nssm.exe" | Select-Object -First 1 }
    Copy-Item $cand.FullName $NSSM_EXE -Force
    Log ("NSSM installed: {0}" -f $NSSM_EXE)
  } else {
    Log ("NSSM present: {0}" -f $NSSM_EXE)
  }
} "Install NSSM if missing"

function Stop-And-Remove-Service($name) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($svc) {
    if ($svc.Status -ne "Stopped") {
      sc.exe stop $name | Out-Null
      Start-Sleep -Seconds 2
    }
    sc.exe delete $name | Out-Null
    Start-Sleep -Seconds 1
    Log ("Service removed: {0}" -f $name)
  }
}

Invoke-Safely { Stop-And-Remove-Service $SVC_BACKEND } "Remove old service: $SVC_BACKEND"
Invoke-Safely { Stop-And-Remove-Service $SVC_WORKER  } "Remove old service: $SVC_WORKER"
Invoke-Safely { Stop-And-Remove-Service $SVC_CADDY   } "Remove old service: $SVC_CADDY"

# Backend service
LogStep "Install backend service"
Invoke-Safely {
  $UVICORN_EXE = (Join-Path $VENV_DIR "Scripts\uvicorn.exe")
  & $NSSM_EXE install $SVC_BACKEND $UVICORN_EXE $UVICORN_ARGS
  & $NSSM_EXE set $SVC_BACKEND AppDirectory $BACKEND_DIR
  & $NSSM_EXE set $SVC_BACKEND Start SERVICE_AUTO_START
  & $NSSM_EXE set $SVC_BACKEND AppStdout (Join-Path $BACKEND_DIR "backend.out.log")
  & $NSSM_EXE set $SVC_BACKEND AppStderr (Join-Path $BACKEND_DIR "backend.err.log")
} "Install backend service"

# Worker service
LogStep "Install worker service"
Invoke-Safely {
  $PY_EXE        = (Join-Path $VENV_DIR "Scripts\python.exe")
  $WORKER_SCRIPT = (Join-Path $APP_DIR "report_worker.py")
  if (-not (Test-Path $WORKER_SCRIPT)) { throw "Worker script not found: $WORKER_SCRIPT" }
  & $NSSM_EXE install $SVC_WORKER $PY_EXE $WORKER_SCRIPT
  & $NSSM_EXE set $SVC_WORKER AppDirectory $APP_DIR
  & $NSSM_EXE set $SVC_WORKER Start SERVICE_AUTO_START
  & $NSSM_EXE set $SVC_WORKER AppStdout (Join-Path $APP_DIR "worker.out.log")
  & $NSSM_EXE set $SVC_WORKER AppStderr (Join-Path $APP_DIR "worker.err.log")
} "Install worker service"

# Caddy service
LogStep "Install Caddy service"
Invoke-Safely {
  $cmd = "`"$caddyToUse`" run --config `"$CADDYFILE_PATH`" --resume"
  sc.exe create $SVC_CADDY binPath= $cmd start= auto | Out-Null
} "Install Caddy service"

# ---------------- START ----------------
LogStep "Start services"
Invoke-Safely { sc.exe start $SVC_BACKEND | Out-Null } "Start $SVC_BACKEND"
Start-Sleep -Seconds 2
Invoke-Safely { sc.exe start $SVC_WORKER  | Out-Null } "Start $SVC_WORKER"
Start-Sleep -Seconds 2
Invoke-Safely { sc.exe start $SVC_CADDY   | Out-Null } "Start $SVC_CADDY"

Log ""
Log ("Open:  http://{0}/" -f $env:COMPUTERNAME)
Log ("Backend logs: {0}\backend.out.log / backend.err.log" -f $BACKEND_DIR)
Log ("Worker  logs: {0}\worker.out.log  / worker.err.log" -f $APP_DIR)
Log ("Caddy   logs: {0}\logs\caddy-access.log" -f $ROOT)
Log ""
Log "All done."

try { Stop-Transcript | Out-Null } catch { }
