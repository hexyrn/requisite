<#
.SYNOPSIS
  Verifies and stages the third-party PostgreSQL 17 Windows binaries
  artifact (P3 item 3/6) into a deterministic, gitignored build-cache
  location - the one genuine external artifact this whole Windows
  packaging effort has been honest about needing (see
  docs/internal/WINDOWS_INSTALLER_DESIGN.md's "Source / distribution" section).

.DESCRIPTION
  Fails closed: if the supplied ZIP's SHA-256 does not match the pinned,
  independently-verified hash, this script refuses to extract or use it
  AT ALL - a build must never silently proceed with unverified
  third-party binaries. The expected hash is a real, independently
  confirmed value (matches both what the coordinator's own separate
  verification reported AND what the user reported), not something this
  script or any build process invents.

  Deliberately does NOT hard-code any developer's personal path (e.g.
  Brad's Downloads folder) into product source - -ZipPath is a required
  parameter, so the artifact's location is a build-time input, not
  baked into the repository.

  Staging location: `.build-cache\postgresql\` under the repository
  root (gitignored - see .gitignore's "Windows release build staging"
  entry) - deterministic, reproducible (re-running this script always
  extracts to the same place), and outside every source-controlled
  application directory (apps/, packages/, installer/).

.PARAMETER ZipPath
  Path to the PostgreSQL binaries ZIP to verify and stage. Required -
  no default, and deliberately not searched for automatically (a build
  script silently picking up "whatever zip happens to be in Downloads"
  is exactly the kind of implicit, unreproducible behavior this script
  exists to avoid).

.PARAMETER ExpectedSha256
  The pinned, independently-verified hash. Defaults to the real
  PostgreSQL 17.11-4 Windows x64 binaries hash confirmed by the
  coordinator's own separate verification:
  b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28
  Override only if genuinely staging a different, newly-verified
  version - never to work around a hash mismatch.

.PARAMETER StageDir
  Where the verified ZIP is extracted. Defaults to
  .build-cache\postgresql under the repository root.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [string]$ExpectedSha256 = 'B9424EE7BC60B52450FF910A3630225DF32E633F3CB29C1D126D9299D59AEA28',
    [string]$StageDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.build-cache\postgresql')
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

if (-not (Test-Path $ZipPath)) {
    throw "PostgreSQL artifact not found at: $ZipPath`nThis script does not download PostgreSQL binaries - see docs/internal/WINDOWS_INSTALLER_DESIGN.md's 'Source / distribution' section for where to obtain the official EDB Windows binaries zip."
}

Write-Step "Verifying SHA-256 of $ZipPath (FAIL CLOSED on mismatch - never proceed with an unverified third-party binary artifact)"
$actualHash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash
Write-Host "Expected: $ExpectedSha256"
Write-Host "Actual:   $actualHash"
if ($actualHash.ToUpperInvariant() -ne $ExpectedSha256.ToUpperInvariant()) {
    throw "SHA-256 MISMATCH - refusing to stage this artifact. This is a fail-closed security control, not a warning: an artifact whose hash does not match the independently-verified value must never be trusted, regardless of its filename or apparent contents."
}
Write-Host 'PASS: hash matches the independently-verified value.'

if (Test-Path $StageDir) {
    Write-Step "Removing previous staged PostgreSQL artifact at $StageDir (staging is always deterministic/reproducible - never incrementally merged)"
    Remove-Item -Recurse -Force $StageDir
}
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

Write-Step "Extracting verified ZIP to $StageDir"
Expand-Archive -Path $ZipPath -DestinationPath $StageDir -Force

Write-Step 'Inspecting the extracted archive layout - not assumed, actually checked'
# EDB's binaries zip layout is a top-level "pgsql\" directory containing
# bin\, lib\, share\, include\, etc. - verified below by CHECKING for the
# real files, not by assuming this structure.
$candidateRoots = @($StageDir, (Join-Path $StageDir 'pgsql'))
$pgRoot = $null
foreach ($candidate in $candidateRoots) {
    if (Test-Path (Join-Path $candidate 'bin\postgres.exe')) {
        $pgRoot = $candidate
        break
    }
}
if (-not $pgRoot) {
    # Fall back to a real search rather than giving up - the archive
    # layout is INSPECTED, not assumed, exactly as required.
    $found = Get-ChildItem -Path $StageDir -Recurse -Filter 'postgres.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        $pgRoot = Split-Path (Split-Path $found.FullName -Parent) -Parent
    }
}
if (-not $pgRoot) {
    throw "Could not locate postgres.exe anywhere under the extracted archive ($StageDir) - the archive layout does not match what this script expects. Inspect $StageDir manually before proceeding; refusing to guess."
}
Write-Host "Resolved PostgreSQL root: $pgRoot"

Write-Step 'Verifying every required binary is present (never executing anything unexpected merely because it was in the ZIP)'
$requiredBinaries = @('postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'psql.exe', 'pg_dump.exe', 'pg_restore.exe')
$binDir = Join-Path $pgRoot 'bin'
$missing = @()
foreach ($bin in $requiredBinaries) {
    $binPath = Join-Path $binDir $bin
    if (Test-Path $binPath) {
        Write-Host "  found: bin\$bin"
    }
    else {
        $missing += $bin
    }
}
if ($missing.Count -gt 0) {
    throw "Required PostgreSQL binaries missing from the staged artifact: $($missing -join ', ') (looked under $binDir)"
}

Write-Step 'Verifying the staged binary reports PostgreSQL 17.x (never silently accept a different major version)'
$versionOutput = & (Join-Path $binDir 'postgres.exe') --version
Write-Host $versionOutput
if ($versionOutput -notmatch 'PostgreSQL\)\s*17\.') {
    throw "Staged postgres.exe is not PostgreSQL 17.x (got: $versionOutput) - Hexyrn Core/Requisite 1.0 standardize on PostgreSQL 17."
}

Write-Host "`nPostgreSQL artifact verified and staged successfully."
Write-Host "  Zip SHA-256:  $actualHash"
Write-Host "  Staged root:  $pgRoot"
Write-Host "  Binaries dir: $binDir"
return @{ PgRoot = $pgRoot; BinDir = $binDir; Version = $versionOutput; Sha256 = $actualHash }
