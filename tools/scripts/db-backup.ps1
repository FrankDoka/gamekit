param(
  [string]$BackupDir,
  [int]$RetentionCount = 14,
  [string]$ExpectedContainer = "gamekit-db-1",
  [string]$ExpectedProject = "gamekit",
  [string]$ExpectedService = "db",
  [string]$ExpectedVolume = "gamekit_pgdata",
  [string]$Database = "gamekit",
  [string]$Username = "gamekit"
)

$ErrorActionPreference = "Stop"

function Repo-Root {
  return (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
}

function Default-BackupDir {
  return (Join-Path (Repo-Root) "tools/_db-backups")
}

function Docker-Lines {
  param([string[]]$DockerArgs)
  $output = & docker @DockerArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($DockerArgs -join ' ') failed: $output"
  }
  return @($output)
}

function Label-Value {
  param([string]$Labels, [string]$Key)
  if ([string]::IsNullOrWhiteSpace($Labels)) {
    return ""
  }
  foreach ($part in $Labels -split ",") {
    $pair = $part -split "=", 2
    if ($pair.Length -eq 2 -and $pair[0] -eq $Key) {
      return $pair[1]
    }
  }
  return ""
}

function Assert-DbIdentity {
  $ownerRows = Docker-Lines -DockerArgs @("ps", "--filter", "publish=5432", "--format", "{{json .}}")
  $owners = @()
  foreach ($line in $ownerRows) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    $row = $line | ConvertFrom-Json
    $owners += [pscustomobject]@{
      Name = [string]$row.Names
      Project = Label-Value ([string]$row.Labels) "com.docker.compose.project"
      Service = Label-Value ([string]$row.Labels) "com.docker.compose.service"
      Ports = [string]$row.Ports
    }
  }

  $owner = $owners | Where-Object { $_.Name -eq $ExpectedContainer } | Select-Object -First 1
  if ($null -eq $owner) {
    $ownerText = if ($owners.Count -gt 0) {
      ($owners | ForEach-Object { "$($_.Name) project=$($_.Project) service=$($_.Service)" }) -join "; "
    } else {
      "none"
    }
    throw "DB identity check refused: 5432 is not owned by $ExpectedContainer; owners: $ownerText"
  }
  if ($owner.Project -ne $ExpectedProject -or $owner.Service -ne $ExpectedService) {
    throw "DB identity check refused: $($owner.Name) labels project=$($owner.Project) service=$($owner.Service), expected project=$ExpectedProject service=$ExpectedService"
  }

  $mountJson = (Docker-Lines -DockerArgs @("inspect", $ExpectedContainer, "--format", "{{json .Mounts}}")) -join ""
  $mounts = $mountJson | ConvertFrom-Json
  $hasExpectedVolume = @($mounts | Where-Object { $_.Name -eq $ExpectedVolume -and $_.Destination -eq "/var/lib/postgresql/data" }).Count -gt 0
  if (-not $hasExpectedVolume) {
    $mountText = (@($mounts) | ForEach-Object { "$($_.Name):$($_.Destination)" }) -join "; "
    throw "DB identity check refused: $ExpectedContainer does not mount $ExpectedVolume at /var/lib/postgresql/data; mounts: $mountText"
  }

  Docker-Lines -DockerArgs @("exec", $ExpectedContainer, "pg_isready", "-U", $Username, "-d", $Database) | Out-Null
  Write-Host "DB identity OK: 5432 -> $ExpectedContainer project=$ExpectedProject service=$ExpectedService volume=$ExpectedVolume"
}

function Rotate-Backups {
  param([string]$Directory, [int]$Keep)
  $files = @(Get-ChildItem -Path $Directory -Filter "gamekit-*.dump" -File | Sort-Object LastWriteTimeUtc -Descending)
  $remove = @($files | Select-Object -Skip $Keep)
  foreach ($file in $remove) {
    Remove-Item -LiteralPath $file.FullName
    Write-Host "Removed old backup: $($file.FullName)"
  }
  return [Math]::Min($files.Count, $Keep)
}

if ([string]::IsNullOrWhiteSpace($BackupDir)) {
  $BackupDir = Default-BackupDir
}
$BackupDir = (New-Item -ItemType Directory -Force -Path $BackupDir).FullName

Assert-DbIdentity

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$fileName = "gamekit-$stamp.dump"
$containerPath = "/tmp/$fileName"
$backupPath = Join-Path $BackupDir $fileName

try {
  Docker-Lines -DockerArgs @("exec", $ExpectedContainer, "pg_dump", "-U", $Username, "-d", $Database, "-Fc", "-f", $containerPath) | Out-Null
  Docker-Lines -DockerArgs @("cp", "$ExpectedContainer`:$containerPath", $backupPath) | Out-Null
} finally {
  try {
    Docker-Lines -DockerArgs @("exec", $ExpectedContainer, "rm", "-f", $containerPath) | Out-Null
  } catch {
    Write-Warning $_
  }
}

$size = (Get-Item -LiteralPath $backupPath).Length
$retained = Rotate-Backups -Directory $BackupDir -Keep $RetentionCount
Write-Host "Backup written: $backupPath ($size bytes)"
Write-Host "Retention: keeping newest $RetentionCount dump(s); retained now: $retained"
