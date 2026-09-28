# Verifies provision-postgres.ps1 refuses the two dangerous situations before touching anything:
#  1. settings exist but the database folder is gone  -> would silently create an empty database
#  2. database exists but its credentials file is gone -> would lock the app out of its own data
# Uses fake PostgreSQL 17 executables, so it runs anywhere PowerShell 7 does (Windows or Linux).
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("prov-guards-" + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$script = Join-Path $PSScriptRoot '..\provision-postgres.ps1'
$isWin = $env:OS -eq 'Windows_NT'
if ($isWin) { Write-Host 'SKIP: needs fake postgres executables (run on Linux/macOS pwsh, or in CI)'; return }
foreach ($e in 'initdb', 'pg_ctl', 'psql', 'postgres', 'pg_dump') {
    $p = Join-Path $bin "$e.exe"
    Set-Content $p "#!/bin/sh`necho 'postgres (PostgreSQL) 17.11'`nexit 0"; chmod +x $p
}
function Expect-Refusal([string]$name, [string]$dataRoot, [string]$pattern) {
    try {
        & $script -PgBinPath $bin -DataDir (Join-Path $dataRoot 'postgresql-data') -DataRoot $dataRoot | Out-Null
        throw "FAIL: $name did not refuse"
    }
    catch {
        if ($_.Exception.Message -notmatch $pattern) { throw "FAIL: $name refused for the wrong reason: $($_.Exception.Message)" }
        Write-Host "PASS: $name"
    }
}
$a = Join-Path $root 'a'; New-Item -ItemType Directory -Force -Path (Join-Path $a 'config') | Out-Null
Set-Content (Join-Path $a 'config\database.env') 'X=1'
Expect-Refusal 'settings without database' $a 'Refusing to create a new empty database'
$b = Join-Path $root 'b'; New-Item -ItemType Directory -Force -Path (Join-Path $b 'postgresql-data'), (Join-Path $b 'config') | Out-Null
Set-Content (Join-Path $b 'postgresql-data\PG_VERSION') '17'
Expect-Refusal 'database without credentials' $b 'credentials file'
Remove-Item -Recurse -Force $root
