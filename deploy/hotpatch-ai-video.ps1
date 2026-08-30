# Run ON THE SERVER (RDP). Pulls AI Video backend files from GitHub, installs
# ffmpeg/TTS packages, restarts PM2.
# Use this when /api/generate-video is 404 or 502 (long IIS proxy timeout).
# Frontend still needs a full deploy.ps1 build for the polling UI.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\hotpatch-ai-video.ps1

$ErrorActionPreference = "Stop"
$dst = "C:\inetpub\wwwroot\ai-marketing-backend"
$base = "https://raw.githubusercontent.com/anasthokan/AI-marketing-tool/main/backend"
$pm2 = "ai-marketing-backend"

if (-not (Test-Path $dst)) {
  throw "Backend folder missing: $dst"
}

$files = @(
  "package.json",
  "package-lock.json",
  "models/Post.js",
  "routes/generate.js",
  "scheduler/postScheduler.js",
  "services/facebookBot.js",
  "services/instagramBot.js",
  "services/videoService.js",
  "services/mptClient.js",
  "utils/ffmpeg.js",
  "utils/media.js",
  "utils/videoProgress.js"
)

foreach ($rel in $files) {
  $out = Join-Path $dst ($rel -replace "/", "\")
  $dir = Split-Path $out -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Host "Downloading $rel ..."
  Invoke-WebRequest -Uri "$base/$rel" -OutFile $out -UseBasicParsing
}

$check = Join-Path $dst "routes\generate.js"
if (-not (Select-String -Path $check -Pattern "generate-video" -Quiet)) {
  throw "Download failed - generate.js missing generate-video route"
}

Write-Host "==> npm install (ffmpeg, edge-tts)"
Push-Location $dst
try {
  npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

Write-Host "Restarting PM2: $pm2"
pm2 restart $pm2 --update-env
Start-Sleep -Seconds 3
pm2 logs $pm2 --lines 25 --nostream

Write-Host ""
Write-Host "OK. Test: https://marketingtool.atozeesolutions.com/ai-video"
Write-Host "Health should include ffmpeg:true -> http://127.0.0.1:5000/api/health"
