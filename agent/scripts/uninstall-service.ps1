param(
  [string]$TaskName = "VisualDatabaseStudioAgent"
)

$ErrorActionPreference = "Stop"
$AgentDir = Split-Path -Parent $PSScriptRoot

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Stopped and removed scheduled service task '$TaskName'."
} else {
  Write-Host "Task '$TaskName' was not registered."
}

$EnvFile = Join-Path $AgentDir ".env.agent"
if (Test-Path $EnvFile) {
  Remove-Item $EnvFile -Force
  Write-Host "Removed pairing configuration file $EnvFile."
}
