# Quick-fix Instagram Edge files onto the live IIS backend (no full rebuild).
# Run on the Windows server in Admin PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\patch-instagram-edge.ps1
param(
  [string]$ServerRepo = "C:\inetpub\wwwroot\AI-marketing-tool-src",
  [string]$BackendDest = "C:\inetpub\wwwroot\ai-marketing-backend",
  [string]$Pm2AppName = "ai-marketing-backend"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $ServerRepo ".git"))) {
  throw "Git repo not found at $ServerRepo — clone the repo there first."
}

Write-Host "==> git pull in $ServerRepo"
Set-Location $ServerRepo
git pull origin main
if ($LASTEXITCODE -ne 0) { throw "git pull failed" }

$files = @(
  "utils\igBrowser.js",
  "services\instagramBot.js",
  "scripts\instagramLogin.js",
  "server.js"
)

foreach ($rel in $files) {
  $src = Join-Path $ServerRepo "backend\$rel"
  $dst = Join-Path $BackendDest $rel
  if (-not (Test-Path $src)) { throw "Missing source: $src" }
  $dstDir = Split-Path $dst -Parent
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  Copy-Item $src $dst -Force
  Write-Host "Copied $rel"
}

# Prove Edge helper is live
$check = Join-Path $BackendDest "utils\igBrowser.js"
if (-not (Select-String -Path $check -Pattern "assertEdgeProcess" -Quiet)) {
  throw "Patch failed — igBrowser.js does not contain assertEdgeProcess"
}

Write-Host "==> pm2 restart $Pm2AppName"
pm2 restart $Pm2AppName --update-env
pm2 logs $Pm2AppName --lines 30 --nostream

Write-Host ""
Write-Host "Done. Look for: Instagram will use: Microsoft Edge @ ...msedge.exe"
Write-Host "Then run: cd $BackendDest ; npm run ig:login"
