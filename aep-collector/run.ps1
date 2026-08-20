$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvRoot = Join-Path $toolRoot ".venv"
$python = Join-Path $venvRoot "Scripts\python.exe"

$pipPackage = Join-Path $venvRoot "Lib\site-packages\pip"
if ((-not (Test-Path -LiteralPath $python)) -or (-not (Test-Path -LiteralPath $pipPackage))) {
    python -m venv --clear $venvRoot
    if ($LASTEXITCODE -ne 0) { throw "Failed to create the runtime virtual environment." }
    & $python -m pip install --disable-pip-version-check -r (Join-Path $toolRoot "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Failed to install runtime dependencies." }
}

$env:PYTHONUTF8 = "1"
& $python (Join-Path $toolRoot "app.py")
