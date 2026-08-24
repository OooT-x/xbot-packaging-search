param(
  [string]$TaskName = "FeishuBot",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$TaskPath = "\"
$Starter = Join-Path $PSScriptRoot "start-feishu-bot-autostart.ps1"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DocumentsRoot = Join-Path $env:USERPROFILE "Documents"
$DefaultRuntimeRoot = Get-ChildItem -LiteralPath $DocumentsRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName "bot-reply-rules.md")) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName "logs"))
  } |
  Select-Object -First 1 -ExpandProperty FullName

if ($Remove) {
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    Write-Host "Removed scheduled task: $TaskName"
  } else {
    Write-Host "Scheduled task not found: $TaskName"
  }
  return
}

if (-not (Test-Path -LiteralPath $Starter)) {
  throw "Autostart script not found: $Starter"
}

$runtimeRootArgument = if ($DefaultRuntimeRoot) {
  " -RuntimeRoot `"$DefaultRuntimeRoot`""
} else {
  ""
}
$actionArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Starter`"$runtimeRootArgument"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument $actionArguments `
  -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 7) `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "Action: powershell.exe $actionArguments"
