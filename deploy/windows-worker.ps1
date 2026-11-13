# Start T3 on a Windows worker at every login (T3 has no Windows background service).
# Run once in a NORMAL PowerShell (not as administrator), from this file's folder:
#   powershell -ExecutionPolicy Bypass -File .\windows-worker.ps1
# Remove later with:  Unregister-ScheduledTask -TaskName "T3 for Studio" -Confirm:$false

$t3 = (Get-Command t3 -ErrorAction Stop).Source

# 0.0.0.0 listens on every network adapter, so T3 still starts if Wi-Fi connects after login or
# the machine's address changes. Windows Firewall decides who may connect (allow Private only).
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$t3' serve --host 0.0.0.0 --port 3773`"" `
  -WorkingDirectory $HOME
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "T3 for Studio" -Action $action -Trigger $trigger -Settings $settings `
  -Description "T3 Code server for the Studio hub" -Force | Out-Null

Start-ScheduledTask -TaskName "T3 for Studio"
Write-Host "Registered and started. T3 now starts hidden at every login on port 3773."
