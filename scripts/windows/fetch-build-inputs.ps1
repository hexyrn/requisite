<#
.SYNOPSIS
  Downloads the third-party pieces the installer is built from, verifying each, so a release needs no manual gathering.

.DESCRIPTION
  Node.js and PostgreSQL are fetched from their official hosts and checked against the SHA-256 values pinned in
  stage-node-artifact.ps1 / stage-postgres-artifact.ps1 (a mismatch stops the build). WinSW is pinned in
  stage-winsw-artifact.ps1. The Microsoft C++ runtime is checked for Microsoft's signature by
  stage-vcredist-artifact.ps1. Files are cached under .build-cache\inputs and reused when their hash still matches.
  Returns @{ NodeZip; PostgresZip; }.
#>
[CmdletBinding()]
param([string]$CacheDir = (Join-Path (Get-Location) '.build-cache\inputs'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
function Get-Pinned([string]$script, [string]$param) {
    $m = [regex]::Match((Get-Content (Join-Path $PSScriptRoot $script) -Raw), "\[string\]\`$$param = '([0-9A-Fa-f]{64})'")
    if (-not $m.Success) { throw "Could not read the pinned hash $param from $script" }
    $m.Groups[1].Value.ToUpperInvariant()
}
function Fetch([string]$url, [string]$file, [string]$sha256) {
    $path = Join-Path $CacheDir $file
    if (-not ((Test-Path $path) -and ((Get-FileHash $path -Algorithm SHA256).Hash -eq $sha256))) {
        Write-Host "Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
    }
    $actual = (Get-FileHash $path -Algorithm SHA256).Hash
    if ($actual -ne $sha256) { Remove-Item $path -Force; throw "$file does not match its pinned SHA-256 (got $actual). Refusing to build." }
    Write-Host "OK  $file ($sha256)"
    $path
}
$node = Fetch 'https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip' 'node-v20.20.2-win-x64.zip' (Get-Pinned 'stage-node-artifact.ps1' 'ExpectedSha256')
$pg = Fetch 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip' 'postgresql-17.11-1-windows-x64-binaries.zip' (Get-Pinned 'stage-postgres-artifact.ps1' 'ExpectedSha256')
return @{ NodeZip = $node; PostgresZip = $pg }
