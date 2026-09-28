<#
.SYNOPSIS
  Verifies the Microsoft Visual C++ 2015-2022 x64 runtime installer that ships inside Requisite-Setup.exe.

.DESCRIPTION
  The bundled PostgreSQL engine needs this runtime, and a clean Windows install often lacks it. Microsoft publishes
  only a moving "latest" download, so a fixed hash would break every time Microsoft updates it. Instead this checks
  that the file is validly Authenticode-signed by Microsoft Corporation, and reports its build number, which the
  installer uses to decide whether the runtime already on a PC is new enough.
  Windows only (Get-AuthenticodeSignature). Returns @{ ExePath; Build; Sha256 }.
#>
[CmdletBinding()]
param(
    [string]$ExePath,
    [switch]$Download,
    [string]$StageDir = (Join-Path (Get-Location) '.build-cache\vcredist')
)
$ErrorActionPreference = 'Stop'
if (-not $ExePath) {
    if (-not $Download) { throw 'Give -ExePath <vc_redist.x64.exe> or -Download.' }
    New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
    $ExePath = Join-Path $StageDir 'vc_redist.x64.exe'
    Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $ExePath -UseBasicParsing
}
if (-not (Test-Path $ExePath)) { throw "Not found: $ExePath" }
$sig = Get-AuthenticodeSignature -FilePath $ExePath
if ($sig.Status -ne 'Valid') { throw "vc_redist.x64.exe does not have a valid signature ($($sig.Status)). Refusing to ship it." }
if ($sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw "vc_redist.x64.exe is not signed by Microsoft Corporation ($($sig.SignerCertificate.Subject)). Refusing to ship it." }
$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($ExePath)
$build = [int]$v.FileBuildPart
if ($v.FileMajorPart -ne 14 -or $build -lt 30000) { throw "Unexpected vc_redist.x64.exe version $($v.FileVersion)." }
$hash = (Get-FileHash -Path $ExePath -Algorithm SHA256).Hash
Write-Host "PASS: Microsoft C++ runtime $($v.FileVersion), signed by Microsoft, sha256=$hash"
return @{ ExePath = (Resolve-Path $ExePath).Path; Build = $build; Sha256 = $hash }
