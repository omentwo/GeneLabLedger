$ErrorActionPreference = "Stop"
$BackendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $BackendRoot
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$FrontendIndex = Join-Path $FrontendRoot "dist\index.html"
$FrontendSource = Join-Path $FrontendRoot "src"
$FrontendPublic = Join-Path $FrontendRoot "public"
$FrontendBuildConfigs = @(
    (Join-Path $FrontendRoot "vite.config.ts"),
    (Join-Path $FrontendRoot "vite.config.js"),
    (Join-Path $FrontendRoot "vite.config.mjs"),
    (Join-Path $FrontendRoot "tsconfig.json"),
    (Join-Path $FrontendRoot "tsconfig.app.json"),
    (Join-Path $FrontendRoot "tsconfig.node.json"),
    (Join-Path $FrontendRoot "tailwind.config.js"),
    (Join-Path $FrontendRoot "tailwind.config.ts"),
    (Join-Path $FrontendRoot "postcss.config.js"),
    (Join-Path $FrontendRoot "postcss.config.cjs")
)
Set-Location -LiteralPath $BackendRoot
$env:UV_CACHE_DIR = Join-Path $BackendRoot ".uv-cache"

$VirtualEnv = Join-Path $BackendRoot ".venv"
$Alembic = Join-Path $VirtualEnv "Scripts\alembic.exe"
$Uvicorn = Join-Path $VirtualEnv "Scripts\uvicorn.exe"
$Python = Join-Path $VirtualEnv "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Uvicorn)) {
    uv sync --dev
}

$NeedsFrontendBuild = -not (Test-Path -LiteralPath $FrontendIndex)
if (-not $NeedsFrontendBuild) {
    $DistStamp = (Get-Item -LiteralPath $FrontendIndex).LastWriteTimeUtc
    $SourceFiles = @(
        Get-ChildItem -LiteralPath $FrontendSource -Recurse -File
        Get-ChildItem -LiteralPath $FrontendPublic -Recurse -File -ErrorAction SilentlyContinue
        Get-Item -LiteralPath (Join-Path $FrontendRoot "index.html")
        Get-Item -LiteralPath (Join-Path $FrontendRoot "package.json")
        Get-Item -LiteralPath (Join-Path $FrontendRoot "package-lock.json")
        $FrontendBuildConfigs | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
            Get-Item -LiteralPath $_
        }
    )
    $NeedsFrontendBuild = $null -ne ($SourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $DistStamp } | Select-Object -First 1)
}

if ($NeedsFrontendBuild) {
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

& $Python -c "from app.config import Settings; from app.database import Database; db=Database(Settings().database_url or ''); db.backup_sqlite_before_schema_upgrade(); db.dispose()"
& $Alembic upgrade head
& $Uvicorn app.main:app --host 127.0.0.1 --port 8000
