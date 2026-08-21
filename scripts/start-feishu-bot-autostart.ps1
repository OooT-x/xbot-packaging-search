param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DefaultRuntimeRoot = "C:\Users\ADMIN\Documents\飞书"
if (-not $env:LARK_BOT_RUNTIME_ROOT) {
  $env:LARK_BOT_RUNTIME_ROOT = if (Test-Path -LiteralPath $DefaultRuntimeRoot) {
    $DefaultRuntimeRoot
  } else {
    Join-Path $ProjectRoot "runtime"
  }
}
$LogDir = Join-Path $env:LARK_BOT_RUNTIME_ROOT "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$AutostartLog = Join-Path $LogDir "bot-autostart.log"

function Write-AutostartLog {
  param([string]$Message)
  Add-Content -Encoding UTF8 -LiteralPath $AutostartLog -Value "[$(Get-Date -Format o)] $Message"
}

function Get-ExistingBotProcess {
  $pidPath = Join-Path $LogDir "bot.pid"
  if (Test-Path -LiteralPath $pidPath) {
    $pidText = Get-Content -Encoding UTF8 -LiteralPath $pidPath -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($pidText -match "^\d+$") {
      $process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
      if ($process -and $process.ProcessName -eq "node") {
        return $process
      }
    }
  }

  # Fallback: detect a running listener by its script path regardless of runtime root.
  try {
    $candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like "*lark-bot-listener.js*" }
    foreach ($c in $candidates) {
      $proc = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
      if ($proc) {
        Write-AutostartLog "found running listener without pid file pid=$($proc.Id)"
        return $proc
      }
    }
  } catch {
    Write-AutostartLog "listener process scan unavailable: $($_.Exception.Message)"
  }

  return $null
}

Set-Location -LiteralPath $ProjectRoot

$existing = Get-ExistingBotProcess
if ($existing -and -not $Force) {
  Write-AutostartLog "bot already running pid=$($existing.Id); exiting without duplicate"
  return
}

if ($existing -and $Force) {
  Write-AutostartLog "stopping existing bot pid=$($existing.Id)"
  Stop-Process -Id $existing.Id -Force
  Start-Sleep -Seconds 2
}

$listener = Join-Path $PSScriptRoot "lark-bot-listener.ps1"
$env:LARK_BOT_GROUP_CONTEXT_ALLOW_EXTERNAL_AI = "on"
Write-AutostartLog "DeepSeek group context sharing enabled for this bot session"
Write-AutostartLog "starting listener via $listener"

try {
  & $listener -Voice -AiProvider deepseek
  $exitCode = if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
  Write-AutostartLog "listener exited exitCode=$exitCode"
  exit $exitCode
} catch {
  Write-AutostartLog "listener failed: $($_.Exception.Message)"
  throw
}
