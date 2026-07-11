# Called by Jenkins from the job workspace (laptop OR server).
param(
  [string]$ServerHost = "74.208.184.175",
  [string]$ServerRepo = "C:\inetpub\wwwroot\AI-marketing-tool-src",
  [string]$SshUser = "Administrator"
)

$ErrorActionPreference = "Stop"

Write-Host "ComputerName: $env:COMPUTERNAME"
Write-Host "Workspace:    $PWD"

# Case 1: Jenkins agent is already on the Windows deploy server
if (Test-Path "C:\inetpub\wwwroot") {
  Write-Host "==> Local server deploy (inetpub found)"
  & "$PSScriptRoot\deploy.ps1"
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  exit 0
}

# Case 2: Jenkins on laptop — SSH into server, git pull + deploy
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
cd /d $ServerRepo && git pull origin main && powershell -NoProfile -ExecutionPolicy Bypass -File deploy\deploy.ps1
"@

Write-Host "SSH command: $remoteCmd"
ssh -o StrictHostKeyChecking=no "${SshUser}@${ServerHost}" $remoteCmd
if ($LASTEXITCODE -ne 0) {
  throw "SSH deploy failed (exit $LASTEXITCODE). Check: server repo at $ServerRepo, git pull works, SSH login works."
}

Write-Host "Remote deploy finished."
