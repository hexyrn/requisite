<#
.SYNOPSIS
  Lets other computers on the local network open Requisite (off by default), or turns that off again.

.DESCRIPTION
  A fresh install listens on this computer only (http://localhost:3000) and opens no firewall port.
  This tool - run from an elevated PowerShell by whoever administers the server - changes that:
    * serves Requisite over HTTPS with a certificate for -HostName,
    * accepts sign-ins from https://<HostName>:<port>,
    * opens ONE inbound Windows Firewall rule for that port (Domain and Private networks only),
    * restarts the Requisite service.
  It never turns off certificate validation. Use a certificate your organisation already trusts
  (-CertificatePfx), or -SelfSigned, which makes a certificate you must install on each PC that will connect
  (the public half is written to config\tls\requisite-public.cer). The database is never exposed.

  -Disable reverses everything (the certificate files are kept).

.EXAMPLE
  .\Enable-LanAccess.ps1 -HostName requisite.example.local -CertificatePfx C:\certs\requisite.pfx
.EXAMPLE
  .\Enable-LanAccess.ps1 -HostName SERVER01 -SelfSigned
.EXAMPLE
  .\Enable-LanAccess.ps1 -Disable
#>
[CmdletBinding()]
param(
    [string]$HostName,
    [string]$CertificatePfx,
    [securestring]$PfxPassword,
    [switch]$SelfSigned,
    [switch]$Disable,
    [string]$DataRoot = (Join-Path $env:ProgramData 'Hexyrn Core'),
    [string]$ServiceName = 'HexyrnCore',
    [string]$FirewallRuleName = 'Requisite (LAN access)'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Hexyrn-Common.ps1')

if (-not (Test-IsAdmin)) { throw 'Run this from an elevated (Run as administrator) PowerShell window.' }
$envFile = Join-Path $DataRoot 'config\hexyrn.env'
if (-not (Test-Path $envFile)) { throw "Requisite settings not found: $envFile. Is Requisite installed?" }
$port = [int](Get-EnvFileValue $envFile 'PORT')
if (-not $port) { $port = 3000 }

function Restart-Requisite {
    Restart-Service -Name $ServiceName -Force
    if (-not (Wait-TcpPort -Port $port -TimeoutSeconds 90)) { throw "Requisite did not start listening on port $port after the change. Settings backup: $script:backup" }
}

$backup = "$envFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $envFile $backup

if ($Disable) {
    Set-EnvFileValue $envFile 'HOST' '127.0.0.1'
    Set-EnvFileValue $envFile 'ALLOWED_ORIGINS' "http://localhost:$port,http://127.0.0.1:$port"
    foreach ($k in 'HEXYRN_TLS_PFX_FILE', 'HEXYRN_TLS_PFX_PASSPHRASE', 'HEXYRN_PUBLIC_URL') { Remove-EnvFileValue $envFile $k }
    Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Remove-Item (Join-Path $DataRoot 'public-url.txt') -Force -ErrorAction SilentlyContinue
    Restart-Requisite
    Write-Host 'LAN access is OFF. Requisite is reachable from this computer only (http://localhost).'
    return
}

if (-not $HostName) { throw '-HostName is required (the name people will type, e.g. requisite.example.local).' }
if ($HostName -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') { throw "-HostName '$HostName' is not a valid host name." }
if (-not $SelfSigned -and -not $CertificatePfx) { throw 'Choose a certificate: -CertificatePfx <file> (recommended) or -SelfSigned.' }

$tlsDir = Join-Path $DataRoot 'config\tls'
New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
$pfxTarget = Join-Path $tlsDir 'requisite.pfx'

if ($SelfSigned) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $plain = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'
    $PfxPassword = ConvertTo-SecureString $plain -AsPlainText -Force
    $cert = New-SelfSignedCertificate -DnsName $HostName -CertStoreLocation 'Cert:\LocalMachine\My' -NotAfter (Get-Date).AddYears(2) -KeyExportPolicy Exportable -FriendlyName 'Requisite'
    Export-PfxCertificate -Cert $cert -FilePath $pfxTarget -Password $PfxPassword | Out-Null
    Export-Certificate -Cert $cert -FilePath (Join-Path $tlsDir 'requisite-public.cer') | Out-Null
    Write-Host "Self-signed certificate created. To avoid browser warnings, install $tlsDir\requisite-public.cer on each PC that will connect (Trusted Root Certification Authorities)."
}
else {
    if (-not (Test-Path $CertificatePfx)) { throw "Certificate file not found: $CertificatePfx" }
    if (-not $PfxPassword) { $PfxPassword = Read-Host -AsSecureString 'Password for the certificate file (leave empty if none)' }
    $plain = [System.Net.NetworkCredential]::new('', $PfxPassword).Password
    $probe = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertificatePfx, $plain)
    if ($probe.NotAfter -lt (Get-Date)) { throw "That certificate expired on $($probe.NotAfter)." }
    if (-not $probe.HasPrivateKey) { throw 'That certificate file has no private key.' }
    Copy-Item $CertificatePfx $pfxTarget -Force
}

# The service account may read the certificate; nobody else except administrators.
& icacls $tlsDir /inheritance:r /grant:r "NT SERVICE\$ServiceName`:(OI)(CI)R" '*S-1-5-32-544:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null

$origin = "https://$HostName`:$port"
Set-EnvFileValue $envFile 'HOST' '0.0.0.0'
Set-EnvFileValue $envFile 'HEXYRN_TLS_PFX_FILE' $pfxTarget
Set-EnvFileValue $envFile 'HEXYRN_TLS_PFX_PASSPHRASE' $plain
Set-EnvFileValue $envFile 'ALLOWED_ORIGINS' "$origin,https://localhost:$port"
Set-EnvFileValue $envFile 'HEXYRN_PUBLIC_URL' $origin
Set-Content -Path (Join-Path $DataRoot 'public-url.txt') -Value $origin

Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Domain, Private | Out-Null

Restart-Requisite
Write-Host "LAN access is ON: $origin  (firewall port $port open on Domain/Private networks). PostgreSQL remains private to this computer."
Write-Host "To turn it off: .\Enable-LanAccess.ps1 -Disable"
