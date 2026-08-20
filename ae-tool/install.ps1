[CmdletBinding()]
param(
    [string]$AfterEffectsRoot
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$panelSource = Join-Path $sourceRoot 'XbotPackagingOrganizer.jsx'
$coreSource = Join-Path $sourceRoot 'XbotPackagingOrganizer\manifest-core.js'

if (-not $AfterEffectsRoot) {
    $candidate = Get-ChildItem 'C:\Program Files\Adobe' -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'Adobe After Effects*' } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $candidate) {
        throw 'After Effects was not found under C:\Program Files\Adobe. Pass -AfterEffectsRoot explicitly.'
    }
    $AfterEffectsRoot = $candidate.FullName
}

$resolvedAeRoot = (Resolve-Path -LiteralPath $AfterEffectsRoot).Path
$targetRoot = Join-Path $resolvedAeRoot 'Support Files\Scripts\ScriptUI Panels'
$targetCoreRoot = Join-Path $targetRoot 'XbotPackagingOrganizer'

if (-not (Test-Path -LiteralPath $targetRoot)) {
    throw "AE ScriptUI Panels directory does not exist: $targetRoot"
}

New-Item -ItemType Directory -Path $targetCoreRoot -Force | Out-Null
Copy-Item -LiteralPath $panelSource -Destination (Join-Path $targetRoot 'XbotPackagingOrganizer.jsx') -Force
Copy-Item -LiteralPath $coreSource -Destination (Join-Path $targetCoreRoot 'manifest-core.js') -Force

Write-Output "Installed to: $targetRoot"
Write-Output 'Restart After Effects, then open XbotPackagingOrganizer from the Window menu.'
