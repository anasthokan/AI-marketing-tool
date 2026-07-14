# Bind marketingtool.atozeesolutions.com to IIS on port 80 (no :521 in URL).
# Run ON the Windows server as Administrator:
#   .\deploy\bind-domain.ps1

param(
  [string]$FrontendSite = "ai_marketing_frontend",
  [string]$BackendSite = "ai_marketing_backend",
  [string]$HostName = "marketingtool.atozeesolutions.com",
  [string]$ApiHostName = "api.marketingtool.atozeesolutions.com",
  [string]$ServerIP = "74.208.184.175",
  [switch]$SkipApiBinding
)

$ErrorActionPreference = "Stop"
Import-Module WebAdministration

# Firewall port 80
$fw80 = "AI Marketing HTTP 80"
if (-not (Get-NetFirewallRule -DisplayName $fw80 -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $fw80 -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow | Out-Null
  Write-Host "Firewall: opened TCP 80"
}

function Add-HostBinding {
  param(
    [string]$SiteName,
    [string]$HostHeader,
    [int]$Port = 80
  )

  $site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
  if (-not $site) {
    throw "IIS site not found: $SiteName"
  }

  $info = "${ServerIP}:${Port}:${HostHeader}"
  $exists = $false
  foreach ($b in @($site.bindings.Collection)) {
    if ($b.protocol -eq "http" -and $b.bindingInformation -eq $info) {
      $exists = $true
      break
    }
  }

  if ($exists) {
    Write-Host "Already bound: http://${HostHeader} -> $SiteName"
  } else {
    New-WebBinding -Name $SiteName -Protocol http -IPAddress $ServerIP -Port $Port -HostHeader $HostHeader
    Write-Host "Added binding: http://${HostHeader} -> $SiteName (port $Port)"
  }

  Start-Website -Name $SiteName -ErrorAction SilentlyContinue
}

Write-Host "==> Frontend domain binding..."
Add-HostBinding -SiteName $FrontendSite -HostHeader $HostName -Port 80

if (-not $SkipApiBinding) {
  Write-Host "==> API domain binding (optional)..."
  $backend = Get-Website -Name $BackendSite -ErrorAction SilentlyContinue
  if ($backend) {
    Add-HostBinding -SiteName $BackendSite -HostHeader $ApiHostName -Port 80
    Write-Host ""
    Write-Host "NEXT: rebuild frontend with:"
    Write-Host "  VITE_API_URL=http://$ApiHostName"
    Write-Host "  (or keep http://${ServerIP}:522 until DNS for api subdomain is ready)"
  } else {
    Write-Host "Backend site '$BackendSite' not found — skipped API binding."
  }
}

Write-Host ""
Write-Host "DONE. Open: http://$HostName"
Write-Host "DNS A record must point $HostName -> $ServerIP"
Write-Host "Old URL still works: http://${ServerIP}:521"
