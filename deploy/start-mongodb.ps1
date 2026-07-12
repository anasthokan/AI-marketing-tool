# Find and start MongoDB (mongod) on Windows Server.
# Run as Administrator.

$ErrorActionPreference = "Continue"

Write-Host "==> Looking for MongoDB Windows service..."
Get-Service *mongo* -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType -AutoSize

Write-Host "==> Searching mongod.exe..."
$candidates = @(
  "C:\Program Files\MongoDB\Server\*\bin\mongod.exe",
  "C:\Program Files\MongoDB\*\bin\mongod.exe",
  "C:\mongodb\bin\mongod.exe",
  "C:\Tools\mongodb\bin\mongod.exe"
)
$mongod = Get-ChildItem $candidates -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not $mongod) {
  $mongod = Get-ChildItem -Path "C:\Program Files","C:\Program Files (x86)","C:\" -Filter mongod.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

if ($mongod) {
  Write-Host "Found:" $mongod.FullName
} else {
  Write-Host "mongod.exe NOT found. Compass-only install? Install MongoDB Community Server (MSI)."
  exit 1
}

# Prefer Windows service if present
$svc = Get-Service *mongo* -ErrorAction SilentlyContinue | Select-Object -First 1
if ($svc) {
  Write-Host "Starting service:" $svc.Name
  Start-Service $svc.Name
  Start-Sleep 2
  Get-Service $svc.Name
} else {
  Write-Host "No MongoDB Windows service. Creating data dir and starting mongod..."
  $dbPath = "C:\data\db"
  $logPath = "C:\data\log"
  New-Item -ItemType Directory -Force -Path $dbPath, $logPath | Out-Null

  # Install as service (needs Admin)
  & $mongod.FullName --dbpath $dbPath --logpath "$logPath\mongod.log" --serviceName MongoDB --serviceDisplayName "MongoDB" --install
  Start-Service MongoDB -ErrorAction SilentlyContinue
  if (-not (Get-Service MongoDB -ErrorAction SilentlyContinue)) {
    Write-Host "Service install failed; starting mongod in background..."
    Start-Process -FilePath $mongod.FullName -ArgumentList "--dbpath `"$dbPath`" --bind_ip 127.0.0.1 --port 27017" -WindowStyle Minimized
  }
}

Start-Sleep 2
Write-Host "==> Port 27017 check:"
Test-NetConnection 127.0.0.1 -Port 27017 | Select-Object TcpTestSucceeded, RemotePort
Write-Host "If TcpTestSucceeded=True, run: pm2 restart ai-marketing-backend"
