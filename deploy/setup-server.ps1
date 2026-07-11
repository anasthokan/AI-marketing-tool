# Run ON the Windows server (as Administrator) after copying files.
# Usage:
#   .\setup-server.ps1
#   .\setup-server.ps1 -FrontendPort 520 -BackendPort 5000

param(
  [string]$AppRoot = "C:\apps\ai-marketing",
  [string]$FrontendPort = "520",
  [string]$BackendPort = "5000",
  [string]$SiteName = "ai_marketing_frontend",
  [string]$ServerIP = "74.208.184.175"
)

$ErrorActionPreference = "Stop"

$FrontendPath = Join-Path $AppRoot "frontend"
$BackendPath  = Join-Path $AppRoot "backend"

Write-Host "==> Creating folders..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $FrontendPath | Out-Null
New-Item -ItemType Directory -Force -Path $BackendPath  | Out-Null

# Expect you already copied:
#   deploy\frontend\*  -> C:\apps\ai-marketing\frontend
#   backend\*          -> C:\apps\ai-marketing\backend  (including .env)

if (-not (Test-Path (Join-Path $FrontendPath "index.html"))) {
  throw "Missing $FrontendPath\index.html — copy frontend dist files first."
}
if (-not (Test-Path (Join-Path $BackendPath "server.js"))) {
  throw "Missing $BackendPath\server.js — copy backend folder first."
}
if (-not (Test-Path (Join-Path $BackendPath ".env"))) {
  throw "Missing $BackendPath\.env — copy .env with MONGO_URI / HF_TOKEN / PORT."
}

Write-Host "==> Backend npm install..." -ForegroundColor Cyan
Push-Location $BackendPath
npm install --omit=dev
npx puppeteer browsers install chrome
Pop-Location

Write-Host "==> Firewall rules..." -ForegroundColor Cyan
foreach ($rule in @(
  @{ Name = "AI Marketing Frontend $FrontendPort"; Port = $FrontendPort },
  @{ Name = "AI Marketing Backend $BackendPort"; Port = $BackendPort }
)) {
  if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol TCP -LocalPort $rule.Port -Action Allow | Out-Null
  }
}

Write-Host "==> IIS site..." -ForegroundColor Cyan
Import-Module WebAdministration

if (-not (Get-Website -Name $SiteName -ErrorAction SilentlyContinue)) {
  New-Website -Name $SiteName -PhysicalPath $FrontendPath -Port $FrontendPort -IPAddress $ServerIP -Force
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $FrontendPath
  # Reset binding to IP:port (no domain yet)
  $site = Get-Website -Name $SiteName
  foreach ($b in $site.bindings.Collection) {
    Remove-WebBinding -Name $SiteName -BindingInformation $b.bindingInformation -Protocol $b.protocol -ErrorAction SilentlyContinue
  }
  New-WebBinding -Name $SiteName -Protocol http -IPAddress $ServerIP -Port $FrontendPort
}

Start-Website -Name $SiteName -ErrorAction SilentlyContinue

Write-Host "==> PM2 backend..." -ForegroundColor Cyan
npm install -g pm2
npm install -g pm2-windows-startup

# Ensure PORT in env for this run
$env:PORT = $BackendPort
$env:PUPPETEER_HEADLESS = "true"
$env:NODE_ENV = "production"

Push-Location $BackendPath
pm2 delete ai-marketing-backend 2>$null
pm2 start server.js --name ai-marketing-backend --update-env
pm2 save
Pop-Location

try {
  pm2-startup install
} catch {
  Write-Host "pm2-startup skipped (run once as Admin if needed)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "DONE" -ForegroundColor Green
Write-Host "Frontend: http://${ServerIP}:${FrontendPort}"
Write-Host "Backend:  http://${ServerIP}:${BackendPort}"
Write-Host "When domain is ready: add HTTPS binding in IIS + update frontend VITE_API_URL and rebuild."
