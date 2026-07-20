# Called by Jenkins from the job workspace (laptop OR server).
param(
  [string]$ServerHost = "74.208.184.175",
  [string]$ServerRepo = "C:\inetpub\wwwroot\AI-marketing-tool-src",
  [string]$SshUser = "Administrator",
  [string]$GitUrl = "https://github.com/anasthokan/AI-marketing-tool.git"
)

$ErrorActionPreference = "Stop"

Write-Host "ComputerName: $env:COMPUTERNAME"
Write-Host "Workspace:    $PWD"
try {
  Write-Host "Git HEAD:     $(git rev-parse --short HEAD)"
  Write-Host "Git message:  $(git log -1 --pretty=%s)"
} catch {}

# Case 1: Jenkins agent is already on the Windows deploy server
if (Test-Path "C:\inetpub\wwwroot") {
  Write-Host "==> Local server deploy (inetpub found)"
  & "$PSScriptRoot\deploy.ps1"
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  exit 0
}

# Case 2: Jenkins on laptop — SSH into server, ensure repo exists, pull + deploy
Write-Host "==> Remote deploy via SSH to $ServerHost"

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw @"
OpenSSH Client missing on this PC.

Fix ONE of these:
  A) Settings → Apps → Optional features → OpenSSH Client
  B) Install Jenkins agent ON the server ($ServerHost) and run this job there
"@
}

$remoteCmd = @"
if not exist "$ServerRepo\.git" (
  echo Cloning repo to $ServerRepo
  if not exist "C:\inetpub\wwwroot" mkdir "C:\inetpub\wwwroot"
  git clone $GitUrl "$ServerRepo"
)
cd /d "$ServerRepo" || exit /b 1
git fetch origin main || exit /b 1
git reset --hard origin/main || exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\deploy.ps1
exit /b %ERRORLEVEL%
"@

Write-Host "SSH command: $remoteCmd"
ssh -o StrictHostKeyChecking=no "${SshUser}@${ServerHost}" $remoteCmd
if ($LASTEXITCODE -ne 0) {
  throw "SSH deploy failed (exit $LASTEXITCODE). Check: git clone works on server, SSH login works."
}

Write-Host "Remote deploy finished."
