$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvExampleFile = Join-Path $ProjectRoot ".env.example"
$EnvFile = Join-Path $ProjectRoot ".env"
$DataDir = Join-Path $ProjectRoot "data"
$LogFile = Join-Path $DataDir "install-dev.log"
$DevProcess = $null

function Require-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "[install] missing command: $Name"
  }
}

function Get-EnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Key
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  foreach ($line in (Get-Content -Path $Path)) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    if ($line.TrimStart().StartsWith("#")) {
      continue
    }
    if ($line -match "^\s*$Key\s*=\s*(.*)\s*$") {
      $value = $Matches[1].Trim()
      $value = $value.Trim("'").Trim('"')
      return $value
    }
  }

  return $null
}

function Test-Health {
  param([Parameter(Mandatory = $true)][string]$Url)
  try {
    Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 2 -UseBasicParsing | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-ForHealth {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][int]$Attempts
  )
  for ($i = 1; $i -le $Attempts; $i++) {
    if (Test-Health -Url $Url) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

try {
  Write-Host "[install] project root: $ProjectRoot"

  Require-Command -Name "node"
  Require-Command -Name "npm"

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

  if (-not (Test-Path $EnvFile)) {
    if (-not (Test-Path $EnvExampleFile)) {
      throw "[install] missing .env.example, cannot initialize .env"
    }
    Copy-Item -Path $EnvExampleFile -Destination $EnvFile
    Write-Host "[install] created .env from .env.example"
  } else {
    Write-Host "[install] .env already exists, keep current config"
  }

  Write-Host "[install] installing npm dependencies..."
  Push-Location $ProjectRoot
  try {
    npm install
  } finally {
    Pop-Location
  }

  $HostValue = Get-EnvValue -Path $EnvFile -Key "HOST"
  if ([string]::IsNullOrWhiteSpace($HostValue)) {
    $HostValue = "127.0.0.1"
  }

  $PortValue = Get-EnvValue -Path $EnvFile -Key "PORT"
  if ([string]::IsNullOrWhiteSpace($PortValue)) {
    $PortValue = "3000"
  }

  $HealthUrl = "http://${HostValue}:${PortValue}/health"

  if (Test-Health -Url $HealthUrl) {
    Write-Host "[install] health check passed (service already running): $HealthUrl"
    exit 0
  }

  Write-Host "[install] starting temporary dev server for health check..."
  $DevProcess = Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("run", "dev") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $LogFile `
    -PassThru

  if ($null -eq $DevProcess) {
    throw "[install] failed to start temporary dev server"
  }

  if (Wait-ForHealth -Url $HealthUrl -Attempts 45) {
    Write-Host "[install] health check passed: $HealthUrl"
    Write-Host "[install] install workflow succeeded"
    exit 0
  }

  Write-Host "[install] health check failed: $HealthUrl" -ForegroundColor Red
  if (Test-Path $LogFile) {
    Write-Host "[install] recent dev log:"
    Get-Content -Path $LogFile -Tail 80
  }
  exit 1
} finally {
  if ($null -ne $DevProcess) {
    try {
      if (-not $DevProcess.HasExited) {
        Stop-Process -Id $DevProcess.Id -Force -ErrorAction SilentlyContinue
      }
    } catch {
      # ignore cleanup errors
    }
  }
}
