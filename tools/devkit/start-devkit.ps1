$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir "..\..")
$port = 8787
$url = "http://127.0.0.1:$port/"

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique

if ($existing) {
  Write-Host "GameKit Dev Kit is already running at $url"
  Start-Process $url
  Start-Sleep -Seconds 2
  exit 0
}

Set-Location -LiteralPath $repoRoot.Path
Write-Host "Starting GameKit Dev Kit at $url"
Write-Host "Leave this window open while using it, or use the Stop shortcut."
Start-Process $url
# Assets root: honor $env:ASSETS_ROOT if the game wires one; otherwise let the DevKit fall
# back to its toolkit-config default (<GAME_ROOT>/assets-bank). No hardcoded absolute path.
if ($env:ASSETS_ROOT) {
  pnpm devkit -- --port $port --assets-root "$env:ASSETS_ROOT"
} else {
  pnpm devkit -- --port $port
}
