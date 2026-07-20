# Deploy AI Marketing Platform on the Windows server (IIS + PM2).
param(
  [string]$FrontendDest = "C:\inetpub\wwwroot\ai-marketing-frontend",
  [string]$BackendDest = "C:\inetpub\wwwroot\ai-marketing-backend",
  # Empty = same-origin /api via frontend IIS reverse proxy (HTTPS-safe)
  [string]$ApiUrl = "",
  [string]$Pm2AppName = "ai-marketing-backend"
)

$ErrorActionPreference = "Stop"

# Ensure npm/pm2 visible to non-interactive Jenkins PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path", "User")

function Assert-Command($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "Command not found in PATH: $name" }
  Write-Host "OK $name -> $($cmd.Source)"
}

Assert-Command npm
Assert-Command node

$Root = $PSScriptRoot
if ($Root) { $Root = Split-Path -Parent $Root }
if (-not (Test-Path (Join-Path $Root "frontend\package.json"))) {
  if ($env:GITHUB_WORKSPACE -and (Test-Path (Join-Path $env:GITHUB_WORKSPACE "frontend\package.json"))) {
    $Root = $env:GITHUB_WORKSPACE
  } elseif ($env:WORKSPACE -and (Test-Path (Join-Path $env:WORKSPACE "frontend\package.json"))) {
    $Root = $env:WORKSPACE
  } else {
    $Root = (Get-Location).Path
  }
}

Write-Host "==> Repo root: $Root"
Write-Host "==> Node: $(node -v)  npm: $(npm -v)"

# ---- Frontend build ----
$Frontend = Join-Path $Root "frontend"
Set-Location $Frontend
"VITE_API_URL=$ApiUrl" | Set-Content -Path ".env.production" -Encoding ASCII

Write-Host "==> npm install (frontend)"
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "frontend npm install failed ($LASTEXITCODE)" }

Write-Host "==> npm run build"
npm run build
if ($LASTEXITCODE -ne 0) { throw "frontend build failed ($LASTEXITCODE)" }

$Dist = Join-Path $Frontend "dist"
if (-not (Test-Path (Join-Path $Dist "index.html"))) {
  throw "dist/index.html missing after build"
}

Write-Host "==> Deploy frontend -> $FrontendDest"
New-Item -ItemType Directory -Force -Path $FrontendDest | Out-Null
Get-ChildItem $FrontendDest -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$Dist\*" $FrontendDest -Recurse -Force
Write-Host "Frontend deployed."

# ---- Backend (keep server .env) ----
Write-Host "==> Deploy backend -> $BackendDest"
New-Item -ItemType Directory -Force -Path $BackendDest | Out-Null

$envBackup = Join-Path $env:TEMP "ai-marketing-backend.env.bak"
$serverEnv = Join-Path $BackendDest ".env"
if (Test-Path $serverEnv) {
  Copy-Item $serverEnv $envBackup -Force
}

$BackendSrc = Join-Path $Root "backend"
$exclude = @("node_modules", "facebook-session", "instagram-session", "instagram-session-edge", "linkedin-session", ".git")
Get-ChildItem $BackendSrc -Force | Where-Object {
  -not ($_.PSIsContainer -and $exclude -contains $_.Name)
} | ForEach-Object {
  $dest = Join-Path $BackendDest $_.Name
  if ($_.Name -eq ".env") { return }
  if ($_.PSIsContainer) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $_.FullName $dest -Recurse -Force
  } else {
    Copy-Item $_.FullName $dest -Force
  }
}

if (Test-Path $envBackup) {
  Copy-Item $envBackup $serverEnv -Force
  Remove-Item $envBackup -Force
} elseif (-not (Test-Path $serverEnv)) {
  Write-Host "WARNING: No .env on server at $serverEnv"
}

Set-Location $BackendDest
Write-Host "==> npm install (backend)"
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "backend npm install failed ($LASTEXITCODE)" }

Write-Host "==> Restart PM2: $Pm2AppName"
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
  Write-Host "WARNING: pm2 not in PATH - frontend is deployed; start backend manually."
} else {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  pm2 describe $Pm2AppName 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    pm2 restart $Pm2AppName --update-env
  } else {
    pm2 start server.js --name $Pm2AppName
  }
  pm2 save
  $ErrorActionPreference = $prev
}

Write-Host "DONE"
Write-Host "Frontend: $FrontendDest"
Write-Host "Backend PM2: http://127.0.0.1:5000"
Write-Host "Backend IIS: http://74.208.184.175:522"

# Ensure IIS backend site (reverse proxy) exists
$setupIis = Join-Path $PSScriptRoot "setup-iis-backend.ps1"
if (Test-Path $setupIis) {
  Write-Host "==> Ensuring IIS backend site..."
  try {
    & $setupIis -PhysicalPath $BackendDest
  } catch {
    Write-Host "WARNING: IIS backend site setup failed: $($_.Exception.Message)"
    Write-Host "Run manually as Admin: deploy\setup-iis-backend.ps1"
  }
}