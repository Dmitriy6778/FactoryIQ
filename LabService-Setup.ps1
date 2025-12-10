# LabService-Setup.ps1
# Laboratory microservice deployment script
# FRONTEND (React) + BACKEND (FastAPI) + NSSM service

param(
  [string]$HostName    = 'factoryiq.local',
  [int]   $LabPort     = 9000,

  # PROD paths
  [string]$LabRoot     = 'C:\inetpub\LabService',
  [string]$FrontProd   = 'C:\inetpub\LabService\frontend_dist',
  [string]$BackProd    = 'C:\inetpub\LabService\backend',

  # DEV paths (in D:\FactoryIQ)
  [string]$FrontDev    = 'D:\FactoryIQ\LabService\frontend',
  [string]$BackDev     = 'D:\FactoryIQ\LabService\backend',

  # Python venv (prod)
  [string]$VenvPython  = 'C:\inetpub\LabService\backend\venv\Scripts\python.exe',

  # NSSM service name
  [string]$SvcLabApi   = 'labservice-api'
)

$ErrorActionPreference = 'Stop'

function Ok   ($m){ Write-Host $m -ForegroundColor Green }
function Info ($m){ Write-Host $m -ForegroundColor Cyan }
function Warn ($m){ Write-Host $m -ForegroundColor Yellow }
function Fail ($m){ Write-Host $m -ForegroundColor Red; exit 1 }

# -------------------- 1. Prepare folder structure --------------------
function Step-PrepareFolders {
    Info "Creating LabService folder structure..."

    $folders = @(
        $LabRoot,
        $FrontProd,
        $BackProd,
        "$LabRoot\logs",
        "$LabRoot\tooling"
    )

    foreach ($f in $folders) {
        if (-not (Test-Path $f)) {
            New-Item -ItemType Directory -Force -Path $f | Out-Null
            Write-Host "Created: $f"
        } else {
            Write-Host "Exists:  $f"
        }
    }

    Ok "Folders prepared."
}

# -------------------- 2. Build & deploy FRONTEND --------------------
function Step-FrontendBuildAndDeploy {
    Write-Host "=== FRONTEND BUILD & DEPLOY ===" -ForegroundColor Green

    if (-not (Test-Path $FrontDev)) {
        Fail "Frontend sources not found: $FrontDev"
    }

    Push-Location $FrontDev
    try {
        npm install
        npm run build -- --mode production

        $dist = Join-Path $FrontDev "dist"
        if (-not (Test-Path "$dist\index.html")) {
            Fail "Build failed: missing $dist\index.html"
        }

        robocopy $dist $FrontProd /MIR | Out-Null
        Ok "Frontend deployed to $FrontProd"
    }
    finally { Pop-Location }
}

# -------------------- 3. Deploy BACKEND --------------------
function Step-BackendDeploy {
    Write-Host "=== BACKEND DEPLOY ===" -ForegroundColor Green

    if (-not (Test-Path $BackDev)) {
        Fail "Backend sources not found: $BackDev"
    }

    robocopy $BackDev $BackProd /MIR /XD venv __pycache__ | Out-Null

    if (-not (Test-Path $VenvPython)) {
        Info "Creating Python venv..."
        python -m venv "$BackProd\venv"
    }

    $req = Join-Path $BackProd "requirements.txt"
    if (Test-Path $req) {
        & $VenvPython -m pip install -r $req
    } else {
        & $VenvPython -m pip install fastapi "uvicorn[standard]"
    }

    Ok "Backend deployed."
}

# -------------------- 4. Register LabService backend NSSM --------------------
function Step-RegisterService {
    Write-Host "=== REGISTER LAB BACKEND SERVICE ===" -ForegroundColor Green

    try { sc.exe stop  $SvcLabApi | Out-Null } catch {}
    Start-Sleep -Seconds 1
    try { sc.exe delete $SvcLabApi | Out-Null } catch {}

    $uvicornExe = Join-Path (Split-Path $VenvPython -Parent) "uvicorn.exe"
    & $VenvPython -m pip install uvicorn | Out-Null

    nssm install $SvcLabApi $uvicornExe "app.main:app --host 127.0.0.1 --port $LabPort --workers 1 --proxy-headers"
    nssm set $SvcLabApi AppDirectory $BackProd
    nssm set $SvcLabApi AppStdout "$LabRoot\logs\lab_api.out.log"
    nssm set $SvcLabApi AppStderr "$LabRoot\logs\lab_api.err.log"
    nssm set $SvcLabApi Start SERVICE_AUTO_START

    nssm start $SvcLabApi
    Ok "Service registered and started: $SvcLabApi"
}

# -------------------- 5. Verify --------------------
function Step-Verify {
    Write-Host "=== VERIFY ===" -ForegroundColor Green

    try {
        curl.exe -k "https://$HostName/lab-api/health"
    } catch {
        Warn "API health check failed."
    }

    $listener = Get-NetTCPConnection -LocalPort $LabPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        Ok ("Backend listening on port {0} (PID={1})" -f $LabPort, $listener.OwningProcess)
    } else {
        Warn "Nothing is listening on port $LabPort"
    }
}

# -------------------- MENU --------------------
function Show-Menu {
    Write-Host ""
    Write-Host "========== LabService Deployment ==========" -ForegroundColor Magenta
    Write-Host "[1] Prepare folders"
    Write-Host "[2] Build & deploy FRONTEND"
    Write-Host "[3] Deploy BACKEND"
    Write-Host "[4] Register & start service (labservice-api)"
    Write-Host "[5] Verify"
    Write-Host "[0] Exit"
    Write-Host "==========================================="
}

do {
    Show-Menu
    $choice = Read-Host "Select [0-5]"

    try {
        switch ($choice) {
            '1' { Step-PrepareFolders }
            '2' { Step-FrontendBuildAndDeploy }
            '3' { Step-BackendDeploy }
            '4' { Step-RegisterService }
            '5' { Step-Verify }
            '0' { break }
            default { Write-Host "Unknown choice." -ForegroundColor Yellow }
        }
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }

    if ($choice -ne '0') {
        Write-Host ""
        Read-Host "Press Enter to continue..." | Out-Null
    }

} while ($true)
