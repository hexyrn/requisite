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
$base = "http://localhost:$Port"
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
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -Uri "$base/api/v1/health" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $up = $true; break }
    }
    catch { }
    Start-Sleep -Seconds 2
}
if (-not $up) {
    Show-Message "Hexyrn Core is not running yet.`n`nOpen 'Services', start 'Hexyrn Core' (and 'HexyrnPostgreSQL' first if it is stopped), then try again." 'Hexyrn Core'
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
