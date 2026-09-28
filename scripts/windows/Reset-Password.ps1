<#
.SYNOPSIS
  Sets a new password for a Requisite user when they (typically the Owner) are locked out and email is not set up.

.DESCRIPTION
  Run from an elevated PowerShell on the Requisite server. Reads the same protected settings the service uses, so
  it only works for a local administrator. Signs the user out everywhere and clears any sign-in lock. Two-factor
  sign-in is unchanged: use Administration -> Users to reset it, or a recovery code.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Email,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'Hexyrn Core'),
    [string]$DataRoot = (Join-Path $env:ProgramData 'Hexyrn Core')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Hexyrn-Common.ps1')
if (-not (Test-IsAdmin)) { throw 'Run this from an elevated (Run as administrator) PowerShell window.' }

$p1 = Read-Host -AsSecureString 'New password (at least 12 characters)'
$p2 = Read-Host -AsSecureString 'Type it again'
$plain1 = [System.Net.NetworkCredential]::new('', $p1).Password
if ($plain1 -cne [System.Net.NetworkCredential]::new('', $p2).Password) { throw 'The two passwords do not match.' }

$node = Join-Path $InstallDir 'node\node.exe'
$tool = Join-Path $InstallDir 'api\apps\api\dist\tools\reset-password.js'
$env:HEXYRN_ENV_FILE = Join-Path $DataRoot 'config\hexyrn.env'
$env:HEXYRN_NEW_PASSWORD = $plain1
try { & $node $tool --email $Email }
finally { Remove-Item Env:\HEXYRN_NEW_PASSWORD -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { throw "Password was not changed (exit code $LASTEXITCODE)." }
