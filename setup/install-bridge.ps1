$bridgeDir = Join-Path $PSScriptRoot 'bridge'
$node = (Get-Command node.exe).Source

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*bridge.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }

$vbs = Join-Path $bridgeDir 'bridge-hidden.vbs'
@"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$bridgeDir"
shell.Run """$node"" ""$bridgeDir\bridge.mjs""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'MyWayAgentBridge' -Action $action -Trigger $trigger -Settings $settings -Description 'Telegram-Qwen agent bridge (MyWay)' -Force | Out-Null
Start-ScheduledTask -TaskName 'MyWayAgentBridge'

Start-Sleep -Seconds 3
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bridge.mjs*' }
if ($proc) {
    Write-Host "Bridge running (PID $($proc.ProcessId)). Autostart at logon registered." -ForegroundColor Green
} else {
    Write-Host 'Bridge process not found - check bridge\bridge.log' -ForegroundColor Red
    exit 1
}
