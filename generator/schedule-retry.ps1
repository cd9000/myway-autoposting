param([int]$Hours = 3)
$at = (Get-Date).AddHours($Hours)
if ($at.Date -gt (Get-Date).Date -or $at.Hour -ge 22) {
  Write-Output 'too late'
  exit 0
}
$vbs = Join-Path $PSScriptRoot 'generator-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -Once -At $at
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
Register-ScheduledTask -TaskName 'MyWayDraftGeneratorRetry' -Action $action -Trigger $trigger -Settings $settings -Description 'MyWay: one-shot draft generation retry after network failure' -Force | Out-Null
Write-Output ('retry at ' + $at.ToString('dd.MM.yyyy HH:mm'))