# Deploy AI Marketing Platform on the Windows server (IIS + PM2).
# Run from repo root on the server (or via Jenkins / GitHub Actions runner).

param(
  [string]$FrontendDest = "C:\inetpub\wwwroot\ai-marketing-frontend",
  [string]$BackendDest = "C:\inetpub\wwwroot\ai-marketing-backend",
  [string]$ApiUrl = "http://74.208.184.175:5000",
  [string]$Pm2AppName = "ai-marketing-backend"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "frontend\package.json"))) {
  $Root = Get-Location
}

Write-Host "==> Repo root: $Root" -ForegroundColor Cyan

# ---- Frontend build ----
$Frontend = Join-Path $Root "frontend"
Push-Location $Frontend
@"
VITE_API_URL=$ApiUrl
"@ | Set-Content -Path ".env.production" -Encoding UTF8

npm ci
if ($LASTEXITCODE -ne 0) { npm install }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
Pop-Location

$Dist = Join-Path $Frontend "dist"
if (-not (Test-Path (Join-Path $Dist "index.html"))) {
  throw "dist/index.html missing after build"
}

Write-Host "==> Deploy frontend -> $FrontendDest" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $FrontendDest | Out-Null
Get-ChildItem $FrontendDest -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$Dist\*" $FrontendDest -Recurse -Force

# ---- Backend (keep server .env) ----
Write-Host "==> Deploy backend -> $BackendDest" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $BackendDest | Out-Null

$envBackup = Join-Path $env:TEMP "ai-marketing-backend.env.bak"
$serverEnv = Join-Path $BackendDest ".env"
if (Test-Path $serverEnv) {
  Copy-Item $serverEnv $envBackup -Force
}

$BackendSrc = Join-Path $Root "backend"
$exclude = @("node_modules", "facebook-session", "instagram-session", ".git")
Get-ChildItem $BackendSrc -Force | Where-Object {
  -not ($_.PSIsContainer -and $exclude -contains $_.Name)
} | ForEach-Object {
  $dest = Join-Path $BackendDest $_.Name
  if ($_.PSIsContainer) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $_.FullName $dest -Recurse -Force
  } else {
    if ($_.Name -eq ".env") { return }
    Copy-Item $_.FullName $dest -Force
  }
}

if (Test-Path $envBackup) {
  Copy-Item $envBackup $serverEnv -Force
  Remove-Item $envBackup -Force
} elseif (-not (Test-Path $serverEnv)) {
  Write-Host "WARNING: No .env on server. Create $serverEnv before starting." -ForegroundColor Yellow
}

Push-Location $BackendDest
npm ci
if ($LASTEXITCODE -ne 0) { npm install }
Pop-Location

Write-Host "==> Restart PM2: $Pm2AppName" -ForegroundColor Cyan
pm2 describe $Pm2AppName 2>$null
if ($LASTEXITCODE -eq 0) {
  pm2 restart $Pm2AppName --update-env
} else {
  Push-Location $BackendDest
  pm2 start server.js --name $Pm2AppName
  Pop-Location
}
pm2 save

Write-Host "DONE" -ForegroundColor Green
Write-Host "Frontend: IIS site folder updated"
Write-Host "Backend:  http://74.208.184.175:5000"
