param(
  [switch]$SkipAgentInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "=== Visual Database Studio — Windows 11 Localhost Setup ===" -ForegroundColor Cyan

# 1. Verify Node.js >= 22 (required for built-in node:sqlite DatabaseSync)
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "Node.js was not found on PATH. Install Node.js 22 LTS (x64) from https://nodejs.org/."
}
$nodeVerRaw = (& node -v).Trim()
$major = [int]($nodeVerRaw.TrimStart('v').Split('.')[0])
Write-Host "Detected Node.js $nodeVerRaw"
if ($major -lt 22) {
  throw "Visual Database Studio requires Node.js 22 or newer (for native node:sqlite). Found $nodeVerRaw."
}

# 2. Install main app dependencies
Write-Host "`n[1/5] Installing application dependencies..." -ForegroundColor Yellow
npm install

# 3. Install Windows Connector Agent dependencies (unless skipped)
if (-not $SkipAgentInstall) {
  Write-Host "`n[2/5] Installing & building Windows Connector Agent (agent/)..." -ForegroundColor Yellow
  Push-Location (Join-Path $RepoRoot "agent")
  try {
    npm install
    npm run build
  } finally {
    Pop-Location
  }
}

# 4. Create .env from .env.example if missing
Write-Host "`n[3/5] Checking .env configuration..." -ForegroundColor Yellow
$envPath = Join-Path $RepoRoot ".env"
if (-not (Test-Path $envPath)) {
  Copy-Item (Join-Path $RepoRoot ".env.example") $envPath
  Write-Host "Created .env from .env.example. Edit .env to set VDS_MASTER_KEY or GEMINI_API_KEY if desired."
} else {
  Write-Host ".env already exists; leaving untouched."
}

# 5. Run SQLite control-plane migrations
Write-Host "`n[4/5] Applying control-plane database migrations..." -ForegroundColor Yellow
npm run db:migrate

# 6. Production build verification (unless skipped)
if (-not $SkipBuild) {
  Write-Host "`n[5/5] Building frontend production bundle..." -ForegroundColor Yellow
  npm run build
}

Write-Host "`nSetup complete! Launch Visual Database Studio with:" -ForegroundColor Green
Write-Host "  .\scripts\start-dev.ps1   (or: npm run dev)"
Write-Host "Then open http://localhost:3000 in your browser."
