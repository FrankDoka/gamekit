$ErrorActionPreference = "Stop"

$port = 8787
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique

if (-not $listeners) {
  Write-Host "GameKit Dev Kit is not running on port $port."
  Start-Sleep -Seconds 2
  exit 0
}

foreach ($processId in $listeners) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "Stopping GameKit Dev Kit process $processId..."
    Stop-Process -Id $processId -Force
  }
}

Write-Host "GameKit Dev Kit stopped."
Start-Sleep -Seconds 2
