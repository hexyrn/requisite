<#
.SYNOPSIS
  Start Menu entry "Hexyrn Core": waits for the local service, then opens it in the browser.

.DESCRIPTION
  First run (setup not finished): the service leaves a one-time setup code in
  ProgramData\Hexyrn Core\config\bootstrap-token.txt, readable by Administrators only. This script reads it
  (asking for elevation only if it must) and opens the setup page with the code in the URL fragment, which
  the browser never sends to the server, so nothing has to be copied. After setup the file is gone and this
  just opens the app.
#>
[CmdletBinding()]
param([int]$Port = 3000)

$ErrorActionPreference = 'Stop'
# Non-secret, world-readable pointer written by Enable-LanAccess.ps1 when HTTPS/LAN access is on.
$publicUrlFile = Join-Path $env:ProgramData 'Hexyrn Core\public-url.txt'
$base = "http://localhost:$Port"
if (Test-Path $publicUrlFile) {
    $candidate = (Get-Content -Path $publicUrlFile -TotalCount 1).Trim()
    if ($candidate -match '^https?://[A-Za-z0-9.-]+(:\d+)?$') { $base = $candidate }
}
$tokenFile = Join-Path $env:ProgramData 'Hexyrn Core\config\bootstrap-token.txt'

function Show-Message([string]$text, [string]$title = 'Hexyrn Core') {
    (New-Object -ComObject WScript.Shell).Popup($text, 0, $title, 64) | Out-Null
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 1. Wait for the service (it can take a little while after boot / first install).
$up = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port)
        $c.Close()
        $up = $true
        break
    }
    catch { Start-Sleep -Seconds 2 }
}
if (-not $up) {
    Show-Message "Requisite is not running yet.`n`nOpen 'Services', start 'Requisite Database (PostgreSQL)' and then 'Requisite', then try again." 'Requisite'
    exit 1
}

# 2. First run: hand the user their one-time setup code.
if (Test-Path $tokenFile) {
    try {
        $token = (Get-Content -Path $tokenFile -ErrorAction Stop | Select-Object -First 1).Trim()
        Start-Process "$base/setup#token=$token"
        exit 0
    }
    catch [System.UnauthorizedAccessException] {
        if (-not (Test-IsAdmin)) {
            # The file is Administrators-only on purpose; ask Windows for permission once.
            Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", '-Port', $Port)
            exit 0
        }
        throw
    }
}

# 3. Already set up: just open it.
Start-Process $base
