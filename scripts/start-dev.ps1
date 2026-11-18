param(
  [int]$Port = 3000,
  [switch]$Production
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$env:PORT = "$Port"
if (-not $env:APP_URL) {
  $env:APP_URL = "http://localhost:$Port"
}

Write-Host "Applying any pending control-plane migrations..." -ForegroundColor Cyan
npm run db:migrate

if ($Production) {
  Write-Host "Building production frontend bundle..." -ForegroundColor Cyan
  npm run build
  Write-Host "Starting Visual Database Studio in production mode on http://localhost:$Port ..." -ForegroundColor Green
  $env:NODE_ENV = "production"
  npm run start
} else {
  Write-Host "Starting Visual Database Studio (dev mode) on http://localhost:$Port ..." -ForegroundColor Green
  npm run dev
}
