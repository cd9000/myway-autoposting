$genDir = Join-Path $PSScriptRoot 'generator'
$node = (Get-Command node.exe).Source

$vbs = Join-Path $genDir 'generator-hidden.vbs'
@"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$genDir"
shell.Run """$node"" ""$genDir\generate.mjs""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -Daily -At '08:00'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable

Register-ScheduledTask -TaskName 'MyWayDraftGenerator' -Action $action -Trigger $trigger -Settings $settings -Description 'MyWay: daily AI draft generation for Telegram channel' -Force | Out-Null

Write-Host 'Task MyWayDraftGenerator registered: daily at 08:00 (runs missed starts when PC wakes).' -ForegroundColor Green
