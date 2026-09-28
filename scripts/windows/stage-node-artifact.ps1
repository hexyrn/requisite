<#
.SYNOPSIS
  Verifies and stages the official Node.js Windows x64 binary
  distribution (P3 item 5) into a deterministic, gitignored build-cache
  location - the same fail-closed pattern as
  scripts/windows/stage-postgres-artifact.ps1, applied to the second
  (and last) genuine external artifact this Windows packaging effort
  needs.

.DESCRIPTION
  Fails closed: if the supplied ZIP's SHA-256 does not match the pinned,
  independently-verified hash, this script refuses to extract or use it
  AT ALL. The expected hash is a real, independently confirmed value
  (matches both the coordinator's own separate verification and what the
  user reported for node-v20.20.2-win-x64.zip), not invented here.

  Deliberately does NOT hard-code any developer's personal path into
  product source - -ZipPath is a required parameter.

  Staging location: `.build-cache\node\` under the repository root
  (gitignored) - deterministic and reproducible.

.PARAMETER ZipPath
  Path to the official node-v20.20.2-win-x64.zip to verify and stage.

.PARAMETER ExpectedSha256
  Defaults to the real, independently-verified hash for
  node-v20.20.2-win-x64.zip:
  dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77

.PARAMETER StageDir
  Where the verified ZIP is extracted. Defaults to .build-cache\node
  under the repository root.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [string]$ExpectedSha256 = 'DC3700FDD57A63EEDB8FD7E3C7BAAA32E6A740A1B904167FF4204BC68ED8BF77',
    [string]$StageDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.build-cache\node')
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

if (-not (Test-Path $ZipPath)) {
    throw "Node.js artifact not found at: $ZipPath`nThis script does not download Node.js binaries - see docs/internal/WINDOWS_INSTALLER_DESIGN.md's 'Node.js runtime packaging' section for where to obtain the official nodejs.org Windows x64 zip."
}

Write-Step "Verifying SHA-256 of $ZipPath (FAIL CLOSED on mismatch - never proceed with an unverified third-party binary artifact)"
$actualHash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash
Write-Host "Expected: $ExpectedSha256"
Write-Host "Actual:   $actualHash"
if ($actualHash.ToUpperInvariant() -ne $ExpectedSha256.ToUpperInvariant()) {
    throw "SHA-256 MISMATCH - refusing to stage this artifact. Fail-closed security control, not a warning."
}
Write-Host 'PASS: hash matches the independently-verified value.'

if (Test-Path $StageDir) {
    Write-Step "Removing previous staged Node artifact at $StageDir (staging is always deterministic/reproducible - never incrementally merged)"
    Remove-Item -Recurse -Force $StageDir
}
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

Write-Step "Extracting verified ZIP to $StageDir"
Expand-Archive -Path $ZipPath -DestinationPath $StageDir -Force

Write-Step 'Inspecting the extracted archive layout - not assumed, actually checked'
# nodejs.org's official Windows zip layout is a single top-level
# "node-vX.Y.Z-win-x64\" directory containing node.exe directly (plus
# npm/npx cmd shims and their own node_modules) - verified below by
# CHECKING for the real file, not by assuming this structure.
$nodeExeFound = Get-ChildItem -Path $StageDir -Recurse -Filter 'node.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeExeFound) {
    throw "Could not locate node.exe anywhere under the extracted archive ($StageDir) - the archive layout does not match what this script expects. Inspect $StageDir manually before proceeding; refusing to guess."
}
$nodeRoot = Split-Path $nodeExeFound.FullName -Parent
Write-Host "Resolved Node.js root: $nodeRoot"

Write-Step 'Verifying the staged binary reports Node 20.x (never silently accept a different major version)'
$versionOutput = & $nodeExeFound.FullName --version
Write-Host $versionOutput
if ($versionOutput -notmatch '^v20\.') {
    throw "Staged node.exe is not v20.x (got: $versionOutput) - this repository's engines.node and the Docker base image both pin Node 20."
}

Write-Host "`nNode.js artifact verified and staged successfully."
Write-Host "  Zip SHA-256: $actualHash"
Write-Host "  Staged root: $nodeRoot"
Write-Host "  Version:     $versionOutput"
return @{ NodeRoot = $nodeRoot; Version = $versionOutput; Sha256 = $actualHash }
