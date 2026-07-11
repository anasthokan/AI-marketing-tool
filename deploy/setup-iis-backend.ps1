# Creates/updates IIS site for AI Marketing backend (reverse proxy to PM2 :5000).
# Run ON the Windows server as Administrator once (or from Jenkins).

param(
  [string]$SiteName = "ai_marketing_backend",
  [string]$PhysicalPath = "C:\inetpub\wwwroot\ai-marketing-backend",
  [string]$ServerIP = "74.208.184.175",
  [int]$Port = 522
)

$ErrorActionPreference = "Stop"

Import-Module WebAdministration

if (-not (Test-Path $PhysicalPath)) {
  New-Item -ItemType Directory -Force -Path $PhysicalPath | Out-Null
}

# Ensure web.config exists in site folder (copied by deploy.ps1 from repo)
if (-not (Test-Path (Join-Path $PhysicalPath "web.config"))) {
  throw "Missing $PhysicalPath\web.config — run deploy first so backend files (incl. web.config) are copied."
}

# Firewall
$fwName = "AI Marketing Backend IIS $Port"
if (-not (Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $fwName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
}

# App pool
if (-not (Test-Path "IIS:\AppPools\$SiteName")) {
  New-WebAppPool -Name $SiteName | Out-Null
}
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ""

# Site
$existing = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
if (-not $existing) {
  New-Website -Name $SiteName -PhysicalPath $PhysicalPath -Port $Port -IPAddress $ServerIP -ApplicationPool $SiteName | Out-Null
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $PhysicalPath
  # Reset binding
  $site = Get-Website -Name $SiteName
  foreach ($b in @($site.bindings.Collection)) {
    Remove-WebBinding -Name $SiteName -BindingInformation $b.bindingInformation -Protocol $b.protocol -ErrorAction SilentlyContinue
  }
  New-WebBinding -Name $SiteName -Protocol http -IPAddress $ServerIP -Port $Port
}

Start-Website -Name $SiteName -ErrorAction SilentlyContinue

Write-Host "IIS backend site ready:"
Write-Host "  http://${ServerIP}:${Port}/api/health"
Write-Host "Make sure PM2 app ai-marketing-backend is running on port 5000."
Write-Host "IIS needs URL Rewrite + Application Request Routing (ARR) with proxy enabled."
