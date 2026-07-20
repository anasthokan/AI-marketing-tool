# Run ON THE SERVER (RDP) — downloads latest Instagram Edge files from GitHub
# into the live backend. No git repo folder required.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\hotpatch-instagram-edge.ps1
# Or paste the body into Admin PowerShell.

$ErrorActionPreference = "Stop"
$dst = "C:\inetpub\wwwroot\ai-marketing-backend"
$base = "https://raw.githubusercontent.com/anasthokan/AI-marketing-tool/main/backend"
$pm2 = "ai-marketing-backend"

if (-not (Test-Path $dst)) {
  throw "Backend folder missing: $dst"
}

$files = @(
  @{ Rel = "utils/igBrowser.js"; Url = "$base/utils/igBrowser.js" },
  @{ Rel = "services/instagramBot.js"; Url = "$base/services/instagramBot.js" },
  @{ Rel = "scripts/instagramLogin.js"; Url = "$base/scripts/instagramLogin.js" },
  @{ Rel = "server.js"; Url = "$base/server.js" }
)

foreach ($f in $files) {
  $out = Join-Path $dst ($f.Rel -replace "/", "\")
  $dir = Split-Path $out -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Host "Downloading $($f.Rel) ..."
  Invoke-WebRequest -Uri $f.Url -OutFile $out -UseBasicParsing
}

$check = Join-Path $dst "utils\igBrowser.js"
if (-not (Select-String -Path $check -Pattern "assertEdgeProcess" -Quiet)) {
  throw "Download failed — igBrowser.js missing assertEdgeProcess"
}

Write-Host "Restarting PM2: $pm2"
pm2 restart $pm2 --update-env
Start-Sleep -Seconds 3
pm2 logs $pm2 --lines 40 --nostream

Write-Host ""
Write-Host "OK. Look for: Instagram will use: Microsoft Edge @ ...msedge.exe"
Write-Host "Then: cd $dst ; npm run ig:login"
