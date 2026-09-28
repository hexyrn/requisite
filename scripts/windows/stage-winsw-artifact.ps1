<#
.SYNOPSIS
  Verifies (fail closed) and stages the WinSW service-host executable that runs the Requisite app
  as a Windows service. Same model as stage-node-artifact.ps1 / stage-postgres-artifact.ps1.

.DESCRIPTION
  WinSW v2.12.0 "WinSW-x64.exe" (MIT licence; self-contained, so customers need no .NET install).
  The expected SHA-256 is pinned below. This is a build-machine step: customers never run it.

  Either pass -ExePath to a file you downloaded yourself, or pass -Download to fetch it from the
  official GitHub release - the hash is checked either way and a mismatch is fatal.

.PARAMETER ExePath   Path to WinSW-x64.exe.
.PARAMETER Download  Download from https://github.com/winsw/winsw/releases/tag/v2.12.0 first.
.PARAMETER StageDir  Where the verified exe is copied (default .build-cache\winsw).
#>
[CmdletBinding()]
param(
    [string]$ExePath,
    [switch]$Download,
    [string]$ExpectedSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA',
    [string]$StageDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.build-cache\winsw')
)

$ErrorActionPreference = 'Stop'

if (-not $ExePath) {
    if (-not $Download) { throw 'Pass -ExePath <WinSW-x64.exe> or -Download.' }
    New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
    $ExePath = Join-Path $StageDir 'WinSW-x64.download.exe'
    Write-Host 'Downloading WinSW v2.12.0 from the official GitHub release...'
    Invoke-WebRequest -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile $ExePath -UseBasicParsing
}
if (-not (Test-Path $ExePath)) { throw "WinSW executable not found: $ExePath" }

$actual = (Get-FileHash -Path $ExePath -Algorithm SHA256).Hash
Write-Host "Expected: $ExpectedSha256"
Write-Host "Actual:   $actual"
if ($actual.ToUpperInvariant() -ne $ExpectedSha256.ToUpperInvariant()) {
    throw 'SHA-256 MISMATCH - refusing to use this WinSW binary (fail-closed security control, not a warning).'
}

New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
$staged = Join-Path $StageDir 'RequisiteService.exe'
Copy-Item -Force $ExePath $staged
Write-Host "PASS: WinSW verified and staged at $staged"
[pscustomobject]@{ ExePath = $staged; Sha256 = $actual }
