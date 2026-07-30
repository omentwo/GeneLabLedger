$ErrorActionPreference = "Stop"
$BackendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $BackendRoot
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$FrontendIndex = Join-Path $FrontendRoot "dist\index.html"
Set-Location -LiteralPath $BackendRoot
$env:UV_CACHE_DIR = Join-Path $BackendRoot ".uv-cache"

$VirtualEnv = Join-Path $BackendRoot ".venv"
$Alembic = Join-Path $VirtualEnv "Scripts\alembic.exe"
$Uvicorn = Join-Path $VirtualEnv "Scripts\uvicorn.exe"

if (-not (Test-Path -LiteralPath $Uvicorn)) {
    uv sync --dev
}

if (-not (Test-Path -LiteralPath $FrontendIndex)) {
    $Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $Npm) {
        throw "Modern frontend build is missing. Install Node.js, then run npm.cmd install and npm.cmd run build in the frontend directory."
    }
    Set-Location -LiteralPath $FrontendRoot
    if (-not (Test-Path -LiteralPath (Join-Path $FrontendRoot "node_modules"))) {
        & npm.cmd install
    }
    & npm.cmd run build
    Set-Location -LiteralPath $BackendRoot
}

& $Alembic upgrade head
& $Uvicorn app.main:app --host 127.0.0.1 --port 8000
