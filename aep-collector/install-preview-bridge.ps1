param(
    [string]$AfterEffectsRoot = ""
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($AfterEffectsRoot) {
        $arguments += " -AfterEffectsRoot `"$AfterEffectsRoot`""
    }
    $elevated = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
}

$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $toolRoot "ae-bridge\XbotPreviewBridge.jsx"
if (-not (Test-Path -LiteralPath $source)) {
    $source = Join-Path $toolRoot "XbotPreviewBridge.jsx"
}
if (-not (Test-Path -LiteralPath $source)) {
    throw "XbotPreviewBridge.jsx was not found."
}

if ($AfterEffectsRoot) {
    $supportRoot = (Resolve-Path -LiteralPath $AfterEffectsRoot).Path
} else {
    $adobeRoot = Join-Path $env:ProgramFiles "Adobe"
    $candidate = Get-ChildItem -LiteralPath $adobeRoot -Directory -Filter "Adobe After Effects *" |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $candidate) {
        throw "After Effects installation was not found."
    }
    $supportRoot = Join-Path $candidate.FullName "Support Files"
}

$panels = Join-Path $supportRoot "Scripts\ScriptUI Panels"
if (-not (Test-Path -LiteralPath $panels)) {
    throw "ScriptUI Panels directory was not found: $panels"
}
$destination = Join-Path $panels "XbotPreviewBridge.jsx"
Copy-Item -LiteralPath $source -Destination $destination -Force

$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
if ($sourceHash -ne $destinationHash) {
    throw "Installed preview bridge failed the SHA-256 check."
}

Write-Host "Installed: $destination"
Write-Host "Restart AE, then open Window > XbotPreviewBridge.jsx"
