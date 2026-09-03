$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvRoot = Join-Path $toolRoot ".build-venv"
$python = Join-Path $venvRoot "Scripts\python.exe"

$pipPackage = Join-Path $venvRoot "Lib\site-packages\pip"
if ((-not (Test-Path -LiteralPath $python)) -or (-not (Test-Path -LiteralPath $pipPackage))) {
    python -m venv --clear $venvRoot
    if ($LASTEXITCODE -ne 0) { throw "Failed to create the build virtual environment." }
}

& $python -m pip install --disable-pip-version-check -r (Join-Path $toolRoot "requirements.txt") pyinstaller
if ($LASTEXITCODE -ne 0) { throw "Failed to install build dependencies." }

$pythonRoot = (& $python -c "import sys; print(sys.base_prefix)").Trim()
$tkinterModule = Join-Path $pythonRoot "Lib\tkinter"
$tkinterPyd = Join-Path $pythonRoot "DLLs\_tkinter.pyd"
$tclDll = Join-Path $pythonRoot "DLLs\tcl86t.dll"
$tkDll = Join-Path $pythonRoot "DLLs\tk86t.dll"
$tclData = Join-Path $pythonRoot "tcl\tcl8.6"
$tkData = Join-Path $pythonRoot "tcl\tk8.6"
$logoAsset = Join-Path $toolRoot "..\eagle-plugin\logo.png"

$env:PYTHONUTF8 = "1"
Push-Location $toolRoot
try {
    & $python -m PyInstaller `
        --noconfirm `
        --clean `
        --onefile `
        --windowed `
        --name "XbotAepCollector" `
        --hidden-import tkinter `
        --hidden-import tkinter.ttk `
        --hidden-import tkinter.filedialog `
        --hidden-import tkinter.messagebox `
        --add-data "${tkinterModule};tkinter" `
        --add-data "${tclData};_tcl_data" `
        --add-data "${tkData};_tk_data" `
        --add-data "${logoAsset};assets" `
        --add-binary "${tkinterPyd};." `
        --add-binary "${tclDll};." `
        --add-binary "${tkDll};." `
        --collect-all py_aep `
        --collect-all fontTools `
        --distpath (Join-Path $toolRoot "dist") `
        --workpath (Join-Path $toolRoot "build") `
        --specpath (Join-Path $toolRoot "build") `
        (Join-Path $toolRoot "app.py")
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed." }

    & $python -m PyInstaller `
        --noconfirm `
        --clean `
        --onefile `
        --console `
        --name "XbotAepWorker" `
        --collect-all py_aep `
        --collect-all fontTools `
        --distpath (Join-Path $toolRoot "dist") `
        --workpath (Join-Path $toolRoot "build\worker") `
        --specpath (Join-Path $toolRoot "build\worker") `
        (Join-Path $toolRoot "worker.py")
    if ($LASTEXITCODE -ne 0) { throw "AEP Worker build failed." }
}
finally {
    Pop-Location
}

$bridgeDist = Join-Path $toolRoot "dist\AE-Preview-Bridge"
New-Item -ItemType Directory -Force -Path $bridgeDist | Out-Null
Copy-Item -LiteralPath (Join-Path $toolRoot "ae-bridge\XbotPreviewBridge.jsx") -Destination $bridgeDist -Force
Copy-Item -LiteralPath (Join-Path $toolRoot "install-preview-bridge.ps1") -Destination $bridgeDist -Force
$pluginWorker = Join-Path $toolRoot "..\eagle-plugin\workers"
New-Item -ItemType Directory -Force -Path $pluginWorker | Out-Null
Copy-Item -LiteralPath (Join-Path $toolRoot "dist\XbotAepWorker.exe") -Destination (Join-Path $pluginWorker "XbotAepWorker.exe") -Force

Write-Host "Build complete: $(Join-Path $toolRoot 'dist\XbotAepCollector.exe')"
Write-Host "Eagle plugin worker: $(Join-Path $toolRoot 'dist\XbotAepWorker.exe')"
Write-Host "Plugin bundle worker: $(Join-Path $pluginWorker 'XbotAepWorker.exe')"
Write-Host "Optional fast preview bridge: $bridgeDist"
