param(
  [int]$ListenMinutes = 60,
  [switch]$Once,
  [switch]$Voice,
  [ValidateSet("auto", "deepseek", "ollama", "openai")]
  [string]$AiProvider = "auto"
)

$launcher = Join-Path $PSScriptRoot "scripts\lark-bot-listener.ps1"
& $launcher -ListenMinutes $ListenMinutes -Once:$Once -Voice:$Voice -AiProvider $AiProvider
