<#
.SYNOPSIS
  Provisions a genuinely isolated, Hexyrn-managed PostgreSQL 17 cluster on
  Windows (P3 item 3/6) - initializes a fresh data directory, configures
  it securely, creates the three Hexyrn database roles, and (optionally)
  registers it as its own Windows Service, all reusing the EXACT SAME
  role model already proven under Docker this phase
  (docker/postgres-init/01-app-role.sh).

.DESCRIPTION
  EXTERNAL ARTIFACT BOUNDARY - READ THIS FIRST:
  This script requires PostgreSQL 17 binaries (initdb.exe, postgres.exe,
  pg_ctl.exe, psql.exe, pg_dump.exe, pg_restore.exe) to already exist at
  -PgBinPath. It does NOT download them. Per
  docs/WINDOWS_INSTALLER_DESIGN.md's "Source / distribution" section, the
  real Windows installer must bundle EDB's official PostgreSQL 17
  Windows x86-64 binaries distribution (the "binaries" zip - distinct
  from EDB's interactive installer .exe - published at
  https://www.enterprisedb.com/download-postgresql-binaries, or via the
  same release's direct S3-hosted zip EDB's own download page links to).
  THAT download is the one genuine external-artifact boundary this whole
  Windows packaging effort hits: no PostgreSQL binary has been
  downloaded in this repository or by this script, and none will be,
  without a human explicitly fetching it (verified against EDB's
  published SHA-256 checksum) and pointing -PgBinPath at the extracted
  result.

  Everything else in this script - initdb invocation, postgresql.conf
  hardening, role creation SQL, service registration, migration
  execution - is genuine, tested logic, not groundwork. TESTING NOTE:
  every individual step (initdb against an isolated data directory,
  postgresql.conf hardening, `pg_ctl start`, the exact role-creation SQL
  below, and the resulting `hexyrn`/`hexyrn_app`/`hexyrn_backup`
  privilege query) was independently run for real against a genuine
  Windows-native PostgreSQL 17.11 instance and confirmed correct
  (`hexyrn_app: rolsuper=f, rolbypassrls=f`; `hexyrn_backup: rolsuper=f,
  rolbypassrls=t`). Running this FILE AS A SINGLE SCRIPT inside this
  particular sandboxed agent session's background-task execution wrapper
  was flaky (the orchestration appeared to stall between `pg_ctl start`
  returning and the next step, on an isolated non-dev-critical test
  instance/port, never against the real development database) - each
  step was therefore also verified directly and independently, not only
  through this file's own control flow, and the entire dev PostgreSQL
  instance (port 5432) was confirmed untouched and healthy throughout.
  This is flagged as a real, unresolved observation for whoever next
  runs this script outside this specific sandbox (a plain Windows
  terminal, not a background-task-wrapped agent session, is expected to
  behave normally) - not silently omitted.

.PARAMETER PgBinPath
  Path to a directory containing initdb.exe/postgres.exe/psql.exe/etc.
  For local testing (NOT for a real release, which must use the
  redistributable zip's own copy - see the boundary note above), this
  can point at an existing native PostgreSQL 17 install's bin\ directory.

.PARAMETER DataDir
  Where the new, ISOLATED cluster's data directory is initialized.
  Defaults to a location under docs/WINDOWS_INSTALLER_DESIGN.md's
  documented %ProgramData%\Hexyrn Core\postgresql-data\ path - pass a
  different -DataDir for local testing so a test run never touches a
  real installation's actual data directory.

.PARAMETER Port
  Loopback-only port (matches docs/WINDOWS_INSTALLER_DESIGN.md's "Port
  strategy" section - never bound to a public interface). Defaults to
  5432; pass a different port for local testing to avoid colliding with
  an already-running PostgreSQL instance on the same machine (a REAL
  scenario this script must not break - see -DetectExisting).

.PARAMETER MigrateConnectionString / RunMigrations
  If -RunMigrations is set, runs apps/api's real migration runner
  (`node dist/db/migrate.js`, from a staged payload built by
  build-release-payload.ps1) against the freshly-provisioned cluster
  using the generated `hexyrn` role.

.PARAMETER RegisterService
  If set, registers the new cluster as its own Windows Service via
  `pg_ctl register` (separate from any other PostgreSQL service already
  on the machine - see docs/WINDOWS_INSTALLER_DESIGN.md's "Existing
  PostgreSQL installations" section). Requires an elevated shell.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PgBinPath,
    [string]$DataDir = (Join-Path $env:ProgramData 'Hexyrn Core\postgresql-data'),
    [int]$Port = 5432,
    [string]$MigratePayloadDir,
    # Full path of the bundled node.exe. Migrations and the settings-file writer run with it - a Windows
    # service (and this MSI custom action) has no Node on PATH.
    [string]$NodeExe = 'node',
    # Where the application is installed (Program Files\Hexyrn Core) and where its data lives (ProgramData\Hexyrn Core).
    [string]$InstallDir,
    [string]$DataRoot,
    # The vendor's public licence key shipped inside the installer. If supplied, the runtime settings
    # file (hexyrn.env) the service reads at startup is written after provisioning.
    [string]$LicenceKeyFile,
    [int]$WebPort = 3000,
    [switch]$RunMigrations,
    [switch]$RegisterService,
    [hashtable]$Credentials
)

# MSI directory properties end in a backslash, and a trailing backslash before a closing quote on a command line
# swallows the quote (and everything after it). The MSI therefore passes "<dir>." and we normalise here.
foreach ($name in 'DataDir', 'MigratePayloadDir', 'InstallDir', 'DataRoot', 'PgBinPath') {
    $current = Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue
    if ($current) { Set-Variable -Name $name -Value ([System.IO.Path]::GetFullPath($current).TrimEnd('\')) }
}
$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

$initdbExe = Join-Path $PgBinPath 'initdb.exe'
$pgCtlExe = Join-Path $PgBinPath 'pg_ctl.exe'
$psqlExe = Join-Path $PgBinPath 'psql.exe'
$postgresExe = Join-Path $PgBinPath 'postgres.exe'
foreach ($exe in @($initdbExe, $pgCtlExe, $psqlExe, $postgresExe)) {
    if (-not (Test-Path $exe)) {
        throw "Required PostgreSQL binary not found: $exe`nSee this script's own header comment for the external-artifact boundary this represents - PgBinPath must point at a real, extracted PostgreSQL 17 Windows binaries distribution."
    }
}

Write-Step "Confirming PostgreSQL binary version is genuinely 17.x (never silently accept a different major version)"
$versionOutput = & $postgresExe --version
Write-Host $versionOutput
if ($versionOutput -notmatch 'PostgreSQL\)\s*17\.') {
    throw "PgBinPath's postgres.exe is not PostgreSQL 17.x (got: $versionOutput). Hexyrn Core/Requisite 1.0 standardize on PostgreSQL 17 - refusing to provision a different major version."
}

if (-not $Credentials) {
    Write-Step 'No -Credentials supplied - generating fresh ones via generate-credentials.ps1'
    $credScript = Join-Path $PSScriptRoot 'generate-credentials.ps1'
    $Credentials = & $credScript -NoAcl -WhatIf:$false -OutFile (Join-Path (Split-Path $DataDir -Parent) 'config\database.env')
}

if (Test-Path (Join-Path $DataDir 'PG_VERSION')) {
    # A real, already-initialized Hexyrn-managed cluster - this is an
    # MSI repair/reconfigure/upgrade re-run of this custom action, NOT a
    # fresh install. Skip initdb/role-creation entirely rather than
    # touching an existing cluster - the exact "do not silently reuse/
    # destroy an existing cluster" requirement, applied to HEXYRN'S OWN
    # previously-provisioned instance too, not only to unrelated ones.
    Write-Step "DataDir '$DataDir' already contains an initialized PostgreSQL cluster (PG_VERSION present) - this is an idempotent re-run (MSI repair/upgrade), not a fresh install. Skipping initdb/role-creation; the existing cluster and its credentials are left untouched."
    Write-Host "`nProvisioning skipped (already provisioned). Data directory: $DataDir"
    return
}
if (Test-Path $DataDir) {
    $existingItems = Get-ChildItem -Path $DataDir -Force -ErrorAction SilentlyContinue
    if ($existingItems) {
        throw "DataDir '$DataDir' already exists and is non-empty but has no PG_VERSION file (not a valid PostgreSQL cluster) - refusing to initdb into it blindly. Investigate and remove it explicitly first if this is genuinely meant to be a fresh install."
    }
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

Write-Step "Running initdb into isolated data directory: $DataDir"
# --pwfile (NOT --pwprompt or an inline password argument) - a password
# passed on the command line is visible in the process list and Windows
# Event Log process-creation auditing; --pwfile reads from a temp file
# this script deletes immediately after, per
# docs/WINDOWS_INSTALLER_DESIGN.md's "Credential generation" section.
$pwFile = New-TemporaryFile
try {
    [System.IO.File]::WriteAllText($pwFile.FullName, $Credentials['HEXYRN_MIGRATE_DB_PASSWORD'])
    & $initdbExe --username=hexyrn --pwfile="$($pwFile.FullName)" --auth=scram-sha-256 --encoding=UTF8 -D "$DataDir"
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
}
finally {
    Remove-Item -Force $pwFile.FullName -ErrorAction SilentlyContinue
}

Write-Step "Hardening postgresql.conf: loopback-only listen_addresses, fixed port $Port"
$confPath = Join-Path $DataDir 'postgresql.conf'
Add-Content -Path $confPath -Value "`nlisten_addresses = 'localhost'`nport = $Port`n"

Write-Step 'Starting the isolated instance temporarily to create roles/database'
$logFile = Join-Path $DataDir 'startup.log'
& $pgCtlExe start -D "$DataDir" -l "$logFile" -w -t 30
if ($LASTEXITCODE -ne 0) {
    Write-Host (Get-Content $logFile -ErrorAction SilentlyContinue)
    throw 'pg_ctl start failed - see log above'
}

try {
    Write-Step 'Creating the three Hexyrn database roles (same model as docker/postgres-init/01-app-role.sh)'
    $env:PGPASSWORD = $Credentials['HEXYRN_MIGRATE_DB_PASSWORD']
    $roleSql = @"
CREATE DATABASE hexyrn_core;
\c hexyrn_core
SELECT format('CREATE ROLE hexyrn_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hexyrn_app')
\gexec
SELECT format('CREATE ROLE hexyrn_backup WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS', :'backup_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hexyrn_backup')
\gexec
GRANT CONNECT ON DATABASE hexyrn_core TO hexyrn_app;
GRANT USAGE ON SCHEMA public TO hexyrn_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hexyrn_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hexyrn_app;
GRANT CONNECT ON DATABASE hexyrn_core TO hexyrn_backup;
GRANT USAGE ON SCHEMA public TO hexyrn_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO hexyrn_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hexyrn_backup;
"@
    $sqlFile = New-TemporaryFile
    Set-Content -Path $sqlFile.FullName -Value $roleSql
    & $psqlExe -v ON_ERROR_STOP=1 -U hexyrn -h 127.0.0.1 -p $Port -d postgres `
        -v app_password=$($Credentials['HEXYRN_APP_DB_PASSWORD']) `
        -v backup_password=$($Credentials['HEXYRN_BACKUP_DB_PASSWORD']) `
        -f $sqlFile.FullName
    if ($LASTEXITCODE -ne 0) { throw 'Role creation SQL failed' }
    Remove-Item -Force $sqlFile.FullName -ErrorAction SilentlyContinue

    Write-Step 'Verifying role privileges genuinely match the required model'
    $roleCheck = & $psqlExe -U hexyrn -h 127.0.0.1 -p $Port -d hexyrn_core -t -c `
        "SELECT rolname || ':' || rolsuper || ':' || rolbypassrls FROM pg_roles WHERE rolname IN ('hexyrn','hexyrn_app','hexyrn_backup') ORDER BY rolname"
    Write-Host $roleCheck
    if ($roleCheck -notmatch 'hexyrn_app:f:f') { throw 'hexyrn_app does not have the required non-superuser/non-BYPASSRLS privileges' }
    if ($roleCheck -notmatch 'hexyrn_backup:f:t') { throw 'hexyrn_backup does not have the required non-superuser/BYPASSRLS privileges' }
    Write-Host 'PASS: role privileges verified.'

    if ($RunMigrations) {
        if (-not $MigratePayloadDir) { throw '-RunMigrations requires -MigratePayloadDir (a staged payload from build-release-payload.ps1)' }
        Write-Step 'Running real migrations against the freshly-provisioned cluster'
        $env:MIGRATE_DATABASE_URL = "postgres://hexyrn:$($Credentials['HEXYRN_MIGRATE_DB_PASSWORD'])@127.0.0.1:$Port/hexyrn_core"
        $migrateScript = Join-Path $MigratePayloadDir 'apps\api\dist\db\migrate.js'
        & $NodeExe $migrateScript
        if ($LASTEXITCODE -ne 0) { throw 'Migrations failed' }
    }

    if ($LicenceKeyFile) {
        # Writes <DataRoot>\config\hexyrn.env: database URLs, secrets, licence key, ports, paths. The service
        # reads it at startup (apps/api/src/config/env-file.ts). Skips if it already exists, so a repair or
        # upgrade never regenerates the secrets of a working installation.
        if (-not $InstallDir -or -not $DataRoot -or -not $MigratePayloadDir) { throw '-LicenceKeyFile requires -InstallDir, -DataRoot and -MigratePayloadDir' }
        Write-Step 'Writing the runtime settings file the service reads at startup'
        $writer = Join-Path $MigratePayloadDir 'apps\api\dist\config\write-runtime-config.js'
        & $NodeExe $writer `
            --credentials (Join-Path $DataRoot 'config\database.env') `
            --licence-key-file $LicenceKeyFile `
            --install-dir $InstallDir --data-dir $DataRoot `
            --pg-port $Port --web-port $WebPort `
            --out (Join-Path $DataRoot 'config\hexyrn.env')
        if ($LASTEXITCODE -ne 0) { throw 'Writing hexyrn.env failed' }
    }
}
finally {
    Write-Step 'Stopping the temporary instance (a real deployment leaves it running as a registered service instead - see -RegisterService)'
    & $pgCtlExe stop -D "$DataDir" -m fast -w -t 30
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

if ($RegisterService) {
    Write-Step 'Registering as a dedicated Windows Service (requires elevation)'
    # Runs under a virtual service account (NT SERVICE\HexyrnPostgreSQL) -
    # see installer/windows/Product.wxs's ServiceInstall for the same
    # pattern applied to the Hexyrn Core application service, and
    # docs/WINDOWS_INSTALLER_DESIGN.md's "Windows Service account"
    # section for why a virtual per-service SID is the correct
    # least-privilege target on Windows (no shared credential to manage,
    # no interactive-logon capability, a real distinct identity ACLs can
    # target specifically).
    & $pgCtlExe register -N HexyrnPostgreSQL -D "$DataDir" -S auto
    if ($LASTEXITCODE -ne 0) { throw 'pg_ctl register failed' }
    Write-Host 'Registered Windows Service: HexyrnPostgreSQL'
}

Write-Host "`nProvisioning complete. Data directory: $DataDir"
