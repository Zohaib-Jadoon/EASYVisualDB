param(
  [Parameter(Mandatory=$true)]
  [string]$PairingToken,

  [string]$ServerWsUrl = "ws://localhost:3000/agent-ws",
  [string]$TaskName = "VisualDatabaseStudioAgent"
)

$ErrorActionPreference = "Stop"
$AgentDir = Split-Path -Parent $PSScriptRoot
Write-Host "Installing Visual Database Studio Windows Connector Agent from $AgentDir..."

Push-Location $AgentDir
try {
  npm install
  npm run build
} finally {
  Pop-Location
}

$EnvFile = Join-Path $AgentDir ".env.agent"
@(
  "VDS_SERVER_WS_URL=$ServerWsUrl"
  "VDS_PAIRING_TOKEN=$PairingToken"
) | Set-Content -Path $EnvFile -Encoding UTF8

$RunnerScript = Join-Path $AgentDir "run-agent.cmd"
@(
  "@echo off"
  "cd /d `"$AgentDir`""
  "for /f `"usebackq tokens=1,2 delims==`" %%a in (`"$EnvFile`") do set `"%%a=%%b`""
  "node dist/index.js"
) | Set-Content -Path $RunnerScript -Encoding ASCII

$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$RunnerScript`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered and started Windows background task '$TaskName'. Approve the agent in Settings -> Windows Agents."
