<#
.SYNOPSIS
  Final step of installation: proves Requisite is really running before Windows Installer reports success.

.DESCRIPTION
  Waits for both services to be running and for the application to answer its health check. If it does not, this
  script writes what a support engineer needs (service states, recent service and database log lines - with secrets
  removed) to ProgramData\Hexyrn Core\logs\install-failure.txt and fails, which makes Windows Installer roll the
  installation back instead of leaving a half-working product behind. Customer data is never touched by a rollback.
  Written for Windows PowerShell 5.1 (the one built into Windows 10/11).
#>
[CmdletBinding()]
param(
    [string]$DataRoot,
    [int]$TimeoutSeconds = 240
)
$ErrorActionPreference = 'Stop'
if (-not $DataRoot) { $DataRoot = Join-Path $env:ProgramData 'Hexyrn Core' }
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$envFile = Join-Path $DataRoot 'config\hexyrn.env'
$logDir = Join-Path $DataRoot 'logs'

function Get-Setting([string]$name, [string]$default) {
    if (Test-Path $envFile) {
        foreach ($line in Get-Content -Path $envFile) {
            if ($line -match ('^\s*' + [regex]::Escape($name) + '=(.*)$')) { return $Matches[1].Trim() }
        }
    }
    return $default
}

function Protect-Line([string]$text) {
    $t = $text -replace '(postgres(?:ql)?://[^:\s/]+:)[^@\s]+@', '$1<redacted>@'
    $t = $t -replace '(?i)((?:password|passphrase|secret|token|api[_-]?key|authorization|cookie)["'']?\s*[:=]\s*)("[^"]*"|''[^'']*''|\S+)', '$1<redacted>'
    return $t
}

$port = [int](Get-Setting 'PORT' '3000')
$tls = [bool](Get-Setting 'HEXYRN_TLS_PFX_FILE' '')
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$healthy = $false
$why = 'The Requisite service did not start.'
while ((Get-Date) -lt $deadline) {
    $svc = @('HexyrnPostgreSQL', 'HexyrnCore') | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue }
    if (($svc | Where-Object { $_.Status -ne 'Running' }) -or $svc.Count -ne 2) {
        $why = 'A Requisite service is not running (' + (($svc | ForEach-Object { "$($_.Name)=$($_.Status)" }) -join ', ') + ').'
        Start-Sleep -Seconds 3
        continue
    }
    try {
        if ($tls) {
            # HTTPS is on (LAN mode): the certificate is for the public name, so only prove the port is answering.
            $c = New-Object System.Net.Sockets.TcpClient
            $c.Connect('127.0.0.1', $port); $c.Close(); $healthy = $true; break
        }
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/v1/health" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
        $why = "The health check returned HTTP $($r.StatusCode)."
    }
    catch { $why = 'The application is not answering yet: ' + $_.Exception.Message }
    Start-Sleep -Seconds 3
}

if ($healthy) { Write-Host "Requisite is running and healthy (port $port)."; exit 0 }

try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $report = @("Requisite installation check failed at $(Get-Date -Format s)", $why, '')
    $report += Get-Service -Name 'HexyrnPostgreSQL', 'HexyrnCore' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name): $($_.Status)" }
    foreach ($pattern in @((Join-Path $logDir '*.log'), (Join-Path $DataRoot 'postgresql-data\log\*.log'))) {
        Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2 | ForEach-Object {
            $report += ''; $report += "--- $($_.Name) (last 60 lines) ---"
            $report += Get-Content -Path $_.FullName -Tail 60 -ErrorAction SilentlyContinue | ForEach-Object { Protect-Line $_ }
        }
    }
    Set-Content -Path (Join-Path $logDir 'install-failure.txt') -Value $report
}
catch { }
Write-Host "Requisite did not start correctly: $why Details were saved to $logDir\install-failure.txt"
exit 1
