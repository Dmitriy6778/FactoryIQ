# FactoryIQ-Setup.ps1  (PowerShell 5.1 safe / ASCII only)
# One-menu bootstrap for IIS + HTTPS + deploy + Windows services via NSSM

param(
  [string]$SiteName    = 'FactoryIQ.local',
  [string]$HostName    = 'FactoryIQ.local',
  [int]   $HttpsPort   = 443,
  [int]   $UvicornPort = 8000,

  # Paths (adjust if needed)
  [string]$ProdRoot  = 'C:\inetpub\FactoryIQ',
  [string]$FrontProd = 'C:\inetpub\FactoryIQ\frontend_dist',
  [string]$BackProd  = 'C:\inetpub\FactoryIQ\backend',

  # Dev sources on this machine
  [string]$FrontDev  = "$PSScriptRoot\frontend\FactoryIQ-UI",
  [string]$BackDev   = "$PSScriptRoot\backend",

  # IIS pools and app path
  [string]$WebPool    = 'IASWebPool',
  [string]$ApiPool    = 'IASApiPool',
  [string]$ApiAppPath = '/api',

  # Python venv exe
  [string]$VenvPython = 'C:\inetpub\FactoryIQ\backend\venv\Scripts\python.exe',

  # API entry / workers (your structure is backend\app\...)
  [string]$ApiModule  = 'app.main:app',
  [string]$OpcModule  = 'app.polling_worker',
  [string]$RptModule  = 'app.report_worker',

  # Service names
  [string]$SvcApi     = 'factoryiq-api',
  [string]$SvcOpc     = 'factoryiq-opc',
  [string]$SvcRpt     = 'factoryiq-reports'
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration -ErrorAction SilentlyContinue | Out-Null

function Ok   ($m){ Write-Host $m -ForegroundColor Green }
function Info ($m){ Write-Host $m -ForegroundColor Cyan }
function Warn ($m){ Write-Host $m -ForegroundColor Yellow }
function Fail ($m){ Write-Host $m -ForegroundColor Red; exit 1 }

# Helper: get command path if exists
function Get-CmdPath([string]$name){
  try { (Get-Command $name -ErrorAction Stop).Source } catch { $null }
}

# 1) Install IIS features
function Do-InstallIIS {
  Info 'Installing IIS features...'
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-WebServerRole -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-ManagementConsole -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-HttpRedirect -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-ApplicationInit -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-ISAPIExtensions -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-ISAPIFilter -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-RequestFiltering -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-HttpCompressionStatic -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-HttpCompressionDynamic -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-LoggingLibraries -All -NoRestart | Out-Null
  Enable-WindowsOptionalFeature -Online -FeatureName IIS-HttpTracing -All -NoRestart | Out-Null
  Ok 'IIS features enabled.'
  Warn 'Note: URL Rewrite and ARR must be installed via MSI separately.'
}

# 2) Tools (NSSM, Node)
function Do-InstallTools {
  $nssm = Get-CmdPath 'nssm'
  if ($nssm) { Ok ("NSSM found: {0}" -f $nssm) }
  else {
    $choco = Get-CmdPath 'choco'
    if ($choco) {
      Info 'Installing NSSM via Chocolatey...'
      choco install nssm -y | Out-Null
      $nssm = Get-CmdPath 'nssm'
      if ($nssm) { Ok ("NSSM installed: {0}" -f $nssm) } else { Warn 'NSSM not found after choco. Install manually and re-run.' }
    } else {
      Warn 'Chocolatey not found. Install nssm manually (put nssm.exe into PATH) and re-run.'
    }
  }
  try { $nodev = node -v; Ok ("Node.js: {0}" -f $nodev) } catch { Warn 'Node.js not found. Install Node LTS for frontend build.' }
}

# Ensure app pool
function Ensure-Pool([string]$name){
  $poolPath = ("IIS:\AppPools\{0}" -f $name)
  if (-not (Test-Path $poolPath)) { New-WebAppPool -Name $name | Out-Null; Ok ("AppPool created: {0}" -f $name) }
  Set-ItemProperty $poolPath -Name managedRuntimeVersion -Value ""
  Set-ItemProperty $poolPath -Name enable32BitAppOnWin64 -Value $false
  Set-ItemProperty $poolPath -Name processModel.loadUserProfile -Value $true
}

# 3) Configure IIS (site + /api + web.config)
function Do-SetupIIS {
  $APPCMD = "$env:windir\system32\inetsrv\appcmd.exe"
  if (-not (Test-Path $APPCMD)) { Fail 'appcmd.exe not found. Install IIS first.' }

  New-Item -ItemType Directory -Force -Path $ProdRoot,$FrontProd,$BackProd | Out-Null

  # hosts
  $hosts = "$env:windir\System32\drivers\etc\hosts"
  $line  = ("127.0.0.1`t{0}" -f $HostName)
  $hostsText = (Get-Content $hosts -ErrorAction SilentlyContinue) -join "`n"
  if ($hostsText -notmatch [regex]::Escape($HostName)) {
    Add-Content -Path $hosts -Value $line
    Ok ("Added hosts entry: {0}" -f $line)
  } else { Info 'Hosts already contains the hostname.' }

  # site
  $site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
  if (-not $site) {
    New-Website -Name $SiteName -PhysicalPath $FrontProd -HostHeader $HostName -Port 80 -IPAddress '*' | Out-Null
    Ok ("IIS site created: {0}" -f $SiteName)
  } else {
    Set-ItemProperty ("IIS:\Sites\{0}" -f $SiteName) -Name physicalPath -Value $FrontProd
    Info 'IIS site exists: updated physicalPath.'
  }

  Ensure-Pool $WebPool
  Ensure-Pool $ApiPool
  Set-ItemProperty ("IIS:\Sites\{0}" -f $SiteName) -Name applicationPool -Value $WebPool
  # ACL для IIS_IUSRS
& icacls $FrontProd /grant 'IIS_IUSRS:(OI)(CI)RX' /T /Q | Out-Null
& icacls $BackProd  /grant 'IIS_IUSRS:(OI)(CI)RX' /T /Q | Out-Null
  Ok 'ACL for IIS_IUSRS set on frontend/backend.'

  # /api app
  $apiName = $ApiAppPath.TrimStart('/')
  $apiApp  = Get-WebApplication -Site $SiteName -Name $apiName -ErrorAction SilentlyContinue
  if (-not $apiApp) {
    New-WebApplication -Site $SiteName -Name $apiName -PhysicalPath $BackProd -ApplicationPool $ApiPool | Out-Null
    Ok 'IIS application /api created.'
  } else {
    Set-ItemProperty ("IIS:\Sites\{0}{1}" -f $SiteName,$ApiAppPath) -Name physicalPath -Value $BackProd
    Set-ItemProperty ("IIS:\Sites\{0}{1}" -f $SiteName,$ApiAppPath) -Name applicationPool -Value $ApiPool
    Info 'IIS application /api updated.'
  }

   # front web.config
  $frontCfg = Join-Path $FrontProd 'web.config'
@"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>

    <rewrite>
      <rules>
        <!-- НЕ трогаем статику -->
        <rule name="IgnoreStatic" stopProcessing="true">
          <match url="^(assets/|.*\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|txt|json|map))$" ignoreCase="true" />
          <action type="None" />
        </rule>

        <!-- SPA fallback (кроме /api) -->
        <rule name="SPA_Fallback" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_URI}" pattern="^/api($|/)" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
          </conditions>
          <action type="Rewrite" url="/index.html" />
        </rule>
      </rules>
    </rewrite>

    <defaultDocument>
      <files>
        <clear />
        <add value="index.html" />
      </files>
    </defaultDocument>

  </system.webServer>
</configuration>

"@ | Out-File -FilePath $frontCfg -Encoding ascii -Force
  Ok 'Frontend web.config written.'

 # back web.config (reverse proxy -> 127.0.0.1:$UvicornPort)
$backCfg = Join-Path $BackProd 'web.config'
@"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <httpProtocol>
      <customHeaders>
        <add name="X-Forwarded-Proto" value="https" />
      </customHeaders>
    </httpProtocol>
    <rewrite>
      <rules>
        <rule name="proxy-uvicorn" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:$UvicornPort/{R:1}" appendQueryString="true" logRewrittenUrl="true" />
        </rule>
      </rules>
      <outboundRules>
        <!-- Исправлять абсолютные http://127.0.0.1:$UvicornPort/... в ответах -->
        <rule name="ReverseProxyOutboundRule1" preCondition="ResponseIsHtml1">
          <match filterByTags="A, Form, Img, Link, Script" pattern="http://127.0.0.1:$UvicornPort/(.*)" />
          <action type="Rewrite" value="/{R:1}" />
        </rule>
        <preConditions>
          <preCondition name="ResponseIsHtml1">
            <add input="{RESPONSE_CONTENT_TYPE}" pattern="^text/html" />
          </preCondition>
        </preConditions>
      </outboundRules>
    </rewrite>
    <proxy timeout="00:05:00" />
    <security>
      <requestFiltering allowDoubleEscaping="true" />
    </security>
  </system.webServer>
</configuration>
"@ | Out-File -FilePath $backCfg -Encoding ascii -Force
Ok 'Backend web.config written.'



  # ARR proxy (if installed)
  try {
    & "$env:windir\system32\inetsrv\appcmd.exe" set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"True" /commit:apphost | Out-Null
    Ok 'ARR proxy enabled.'
  } catch { Warn 'Could not set proxy section (install URL Rewrite and ARR).' }
}

# 4) Build & deploy frontend
function Do-BuildFrontend {
  if (-not (Test-Path (Join-Path $FrontDev 'package.json'))) { Warn ("package.json not found at {0}" -f $FrontDev); return }
  Push-Location $FrontDev
  try {
    node -v | Out-Null; npm -v | Out-Null
    if (Test-Path (Join-Path $FrontDev 'package-lock.json')) { npm ci } else { npm install }
    npm run build
  } finally { Pop-Location }
  New-Item -ItemType Directory -Force -Path $FrontProd | Out-Null
  robocopy (Join-Path $FrontDev 'dist') $FrontProd /MIR /R:2 /W:1 | Out-Null
  Ok ("Frontend built and copied to {0}" -f $FrontProd)
}

# 5) Deploy backend (copy + venv + requirements)
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

  # ensure package markers
  New-Item -ItemType File -Force -Path (Join-Path $BackProd 'app\__init__.py') | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $BackProd 'app\routers\__init__.py') | Out-Null
  Ok ("Backend deployed to {0}" -f $BackProd)
}

# 6) HTTPS (self-signed + bind SNI + http.sys)
function Do-HTTPS {
  $APPCMD = "$env:windir\system32\inetsrv\appcmd.exe"
  $cert = New-SelfSignedCertificate -DnsName $HostName -CertStoreLocation 'Cert:\LocalMachine\My' -FriendlyName ("{0} self-signed" -f $HostName) -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5)
  $thumb = $cert.Thumbprint
  $cerPath = ("C:\certs\{0}.cer" -f $HostName)
  New-Item -ItemType Directory -Force -Path (Split-Path $cerPath) | Out-Null
  Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
  Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null

  $binding = ('*:{0}:{1}' -f $HttpsPort,$HostName)
  & $APPCMD set site /site.name:"$SiteName" /-bindings.[protocol='https',bindingInformation="$binding"] 2>$null | Out-Null
  & $APPCMD set site /site.name:"$SiteName" /+bindings.[protocol='https',bindingInformation="$binding",sslFlags='1'] | Out-Null

  & netsh http delete sslcert hostnameport=("$HostName`:$HttpsPort") 2>$null | Out-Null
  $appid = '{54b7f2a0-1b20-4b59-9d8a-2f6c6c2d9a7e}'
  & netsh http add sslcert hostnameport=("$HostName`:$HttpsPort") certhash=$thumb certstore=MY appid=$appid | Out-Null

  Ok ("HTTPS ready for https://{0}:{1} (thumb={2})" -f $HostName,$HttpsPort,$thumb)
}

# 7) Register Windows Services (NSSM)

function Do-Services {
  function Remove-Service-Force([string]$Name){
    try { sc.exe stop $Name | Out-Null } catch {}
    Start-Sleep -Seconds 2
    try {
      $svc = Get-CimInstance win32_service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
      if ($svc -and $svc.ProcessId -gt 0) { taskkill /PID $($svc.ProcessId) /T /F | Out-Null }
    } catch {}
    try { sc.exe delete $Name | Out-Null } catch {}
  }

  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
  if (-not $nssm) { Fail 'NSSM not found. Run menu item 2 first.' }
  if (-not (Test-Path $VenvPython)) { Fail ("Venv python not found: {0}. Run menu item 5 first." -f $VenvPython) }

  $logs = Join-Path $BackProd 'logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null

  $FERNET = 'Z3Vls19NlJWSwECAQF7vxEBStOvACn97aPS9fjPileQ='  # TODO: подставь свой при необходимости

  # API (оставляем через uvicorn.exe)
  $uviex = Join-Path (Split-Path $VenvPython -Parent) 'uvicorn.exe'
  if (-not (Test-Path $uviex)) {
    & $VenvPython -m pip install -U "uvicorn[standard]" | Out-Null
    $uviex = Join-Path (Split-Path $VenvPython -Parent) 'uvicorn.exe'
  }
  Remove-Service-Force -Name $SvcApi
  & nssm install $SvcApi $uviex "app.main:app --host 127.0.0.1 --port $UvicornPort --workers 1 --proxy-headers --forwarded-allow-ips 127.0.0.1 --root-path $ApiAppPath" | Out-Null
  & nssm set $SvcApi AppDirectory $BackProd | Out-Null
  & nssm set $SvcApi AppStdout (Join-Path $logs 'api.out.log') | Out-Null
  & nssm set $SvcApi AppStderr (Join-Path $logs 'api.err.log') | Out-Null
  & nssm set $SvcApi AppRotateFiles 1 | Out-Null
  & nssm set $SvcApi AppRotateOnline 1 | Out-Null
  & nssm set $SvcApi AppRotateBytes 10485760 | Out-Null
  & nssm set $SvcApi AppEnvironmentExtra ("PYTHONUNBUFFERED=1","PYTHONPATH=$BackProd") | Out-Null
  & nssm set $SvcApi Start SERVICE_AUTO_START | Out-Null
    # Firewall для локального UVicorn
  try {
    New-NetFirewallRule -DisplayName "FactoryIQ Uvicorn $UvicornPort" -Direction Inbound -LocalPort $UvicornPort -Protocol TCP -Action Allow -Profile Any | Out-Null
  } catch {}

  & nssm start $SvcApi | Out-Null
  Ok 'Service ready: factoryiq-api'

  # OPC: python app\polling_worker.py
  Remove-Service-Force -Name $SvcOpc
  & nssm install $SvcOpc $VenvPython 'app\polling_worker.py' | Out-Null
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

  # REPORTS: python app\report_worker.py
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

  Get-Service $SvcApi,$SvcOpc,$SvcRpt | Select Name,Status,StartType | Format-Table -AutoSize
}



# 8) Verify
function Do-Verify {
  $APPCMD = "$env:windir\system32\inetsrv\appcmd.exe"
  Info 'IIS site bindings:'
  & $APPCMD list site /text:bindings
  Info 'HTTP.SYS SNI record:'
  & netsh http show sslcert hostnameport=("$HostName`:$HttpsPort")
  Info 'API local check:'
  try { & curl.exe ("http://127.0.0.1:{0}/" -f $UvicornPort) } catch { Warn 'curl.exe local check failed' }
  Info 'API via IIS HTTPS check:'
  try { & curl.exe -k ("https://{0}{1}/openapi.json" -f $HostName,$ApiAppPath) } catch { Warn 'curl.exe https check failed' }

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

function Do-Repair {
  Info '=== REPAIR: quick fixes for 500/API and white screen ==='

  # 1) Перегенерируем web.config-ы (могли съехать)
  Do-SetupIIS

  # 2) Проверим/перезапустим службы
  try { sc.exe stop  $SvcApi | Out-Null } catch {}
  Start-Sleep -Seconds 2
  try { sc.exe start $SvcApi | Out-Null } catch {}
  Start-Sleep -Seconds 2

  # 3) Проверим порт UVicorn
  $p = Get-ProcByPort -Port $UvicornPort
  if (-not $p) { Warn ("Nothing listens on {0}" -f $UvicornPort) } else { Ok ("Listening on {0}: PID={1} ({2})" -f $UvicornPort,$p.PID,$p.Process) }

  # 4) Быстрые curl-пробы
  Info 'curl local API:'
  try { & curl.exe ("http://127.0.0.1:{0}/openapi.json" -f $UvicornPort) } catch { Warn 'Local curl failed' }

  Info 'curl via IIS (HTTP):'
  try { & curl.exe ("http://{0}{1}/openapi.json" -f $HostName,$ApiAppPath) } catch { Warn 'IIS HTTP curl failed' }

  Info 'curl via IIS (HTTPS, -k):'
  try { & curl.exe -k ("https://{0}{1}/openapi.json" -f $HostName,$ApiAppPath) } catch { Warn 'IIS HTTPS curl failed' }

  # 5) Статика фронта
  Info 'curl index.html:'
  try { & curl.exe ("http://{0}/" -f $HostName) } catch { Warn 'Front curl failed' }

  # 6) Если /api через IIS даёт 500 — покажем подсказки
  $r = try { (Invoke-WebRequest -UseBasicParsing ("http://{0}{1}/openapi.json" -f $HostName,$ApiAppPath) -Method Head -TimeoutSec 10).StatusCode } catch { $_.Exception.Message }
  if ($r -isnot [int] -or $r -ge 500) {
    Warn "IIS /api returns 5xx. Tips:"
    Write-Host " - Проверьте, что сервис $SvcApi запущен:  sc query $SvcApi" -ForegroundColor Yellow
    Write-Host " - Логи: $BackProd\logs\api.err.log и api.out.log" -ForegroundColor Yellow
    Write-Host " - Проверить включён ли ARR и URL Rewrite (переставить MSI при необходимости)" -ForegroundColor Yellow
  } else {
    Ok "IIS /api OK."
  }
  # 7) Если локальный API или IIS /api падают — показать хвост логов UVicorn
if ($r -isnot [int] -or $r -ge 500) {
  $elog = Join-Path $BackProd 'logs\api.err.log'
  $olog = Join-Path $BackProd 'logs\api.out.log'
  if (Test-Path $elog) { Info "=== tail api.err.log ==="; Get-Content $elog -Tail 80 }
  if (Test-Path $olog) { Info "=== tail api.out.log ==="; Get-Content $olog -Tail 40 }
}

  
}


function Show-Menu {
  Write-Host ''
  Write-Host '===== FactoryIQ Setup =====' -ForegroundColor Magenta
  Write-Host '[1] Install IIS features'
  Write-Host '[2] Install tools (NSSM)'
  Write-Host '[3] Configure IIS (site/app/web.config)'
  Write-Host '[4] Build and deploy FRONTEND'
  Write-Host '[5] Deploy BACKEND (venv + requirements + web.config)'
  Write-Host '[6] HTTPS: issue self-signed cert and bind'
  Write-Host '[7] Register Windows Services (API / OPC / Reports)'
  Write-Host '[8] Verify (bindings, http.sys, curl)'
  Write-Host '[9] Repair (rewrite configs, restart API, quick checks)'
  Write-Host '[0] Exit'
  Write-Host '==========================='
}

do {
  Show-Menu
  $choice = Read-Host 'Select [0-9]'
  try {
    switch ($choice) {
      '1' { Do-InstallIIS }
      '2' { Do-InstallTools }
      '3' { Do-SetupIIS }
      '4' { Do-BuildFrontend }
      '5' { Do-DeployBackend }
      '6' { Do-HTTPS }
      '7' { Do-Services }
      '8' { Do-Verify }
	  '9' { Do-Repair }
      '0' { break }
      default { Write-Host 'Unknown choice' -ForegroundColor Yellow }
    }
  } catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
  }
  if ($choice -ne '0') { Write-Host ''; Read-Host 'Press Enter to continue...' | Out-Null }
} while ($true)
