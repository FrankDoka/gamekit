param(
  [string]$BackupDir,
  [string]$DumpPath,
  [string]$Project = "gamekit_restore_drill",
  [string]$Database = "gamekit",
  [string]$Username = "gamekit",
  [string]$Password = "gamekit_dev"
)

$ErrorActionPreference = "Stop"

function Repo-Root {
  return (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
}

function Default-BackupDir {
  return (Join-Path (Repo-Root) "tools/_db-backups")
}

function Docker-Run {
  param([string[]]$DockerArgs)
  $output = & docker @DockerArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($DockerArgs -join ' ') failed: $output"
  }
  return @($output)
}

function Compose-Run {
  param([string]$ComposeFile, [string[]]$ComposeArgs)
  $dockerArgs = @("compose", "-p", $Project, "-f", $ComposeFile) + $ComposeArgs
  return Docker-Run -DockerArgs $dockerArgs
}

function Latest-Dump {
  param([string]$Directory)
  $latest = Get-ChildItem -Path $Directory -Filter "gamekit-*.dump" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($null -eq $latest) {
    throw "No dump found in $Directory"
  }
  return $latest.FullName
}

if ([string]::IsNullOrWhiteSpace($BackupDir)) {
  $BackupDir = Default-BackupDir
}
if ([string]::IsNullOrWhiteSpace($DumpPath)) {
  $DumpPath = Latest-Dump -Directory $BackupDir
}
$DumpPath = (Resolve-Path $DumpPath).Path

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "gamekit-db-restore-drill"
$tempDir = Join-Path $tempRoot ([Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$composeFile = Join-Path $tempDir "compose.yml"
$containerDump = "/tmp/restore.dump"

@"
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: $Database
      POSTGRES_USER: $Username
      POSTGRES_PASSWORD: $Password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $Username -d $Database"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
"@ | Set-Content -LiteralPath $composeFile -Encoding UTF8

try {
  Compose-Run $composeFile @("up", "-d", "--wait", "db") | Out-Null
  $container = (Compose-Run $composeFile @("ps", "-q", "db") | Select-Object -First 1).Trim()
  if ([string]::IsNullOrWhiteSpace($container)) {
    throw "Restore drill could not find throwaway db container for project $Project"
  }

  Docker-Run -DockerArgs @("cp", $DumpPath, "$container`:$containerDump") | Out-Null
  Docker-Run -DockerArgs @("exec", $container, "pg_restore", "-U", $Username, "-d", $Database, "--clean", "--if-exists", $containerDump) | Out-Null

  $tables = @("accounts", "characters", "character_locations")
  foreach ($table in $tables) {
    $count = (Docker-Run -DockerArgs @("exec", $container, "psql", "-U", $Username, "-d", $Database, "-tAc", "select count(*) from $table;") | Select-Object -First 1).Trim()
    if ($count -notmatch "^\d+$") {
      throw "Restore drill assertion failed: $table count was not numeric: $count"
    }
    Write-Host "Restore drill count: $table=$count"
  }

  Write-Host "Restore drill PASS: restored $DumpPath into throwaway compose project $Project"
} finally {
  try {
    Compose-Run $composeFile @("down", "-v", "--remove-orphans") | Out-Null
    Write-Host "Restore drill cleanup: compose project $Project torn down"
  } catch {
    Write-Warning $_
  }
  Remove-Item -LiteralPath $tempDir -Recurse -Force
}
