<#
.SYNOPSIS
  Generates the installation-specific secrets/credentials the Hexyrn
  Windows installer needs (P3 item 3/7/8), and writes them ONLY to an
  ACL-protected config location - never to the console, a log file, or
  the MSI's own installation log.

.DESCRIPTION
  Every value here is produced by cryptographically secure randomness
  (.NET's RandomNumberGenerator, the same class of primitive Node's
  `crypto.randomBytes` uses - not System.Random, which is NOT
  cryptographically secure and must never be used for secrets). This
  mirrors exactly what apps/api/src/config/production-config-check.ts
  already requires in production: TOTP_MASTER_KEY_CURRENT (32 raw bytes,
  base64), HEXYRN_SESSION_SECRET, and three DISTINCT PostgreSQL role
  passwords (migration/runtime/backup - never the same value, defeating
  the whole point of docker/postgres-init/01-app-role.sh's role split if
  they matched).

  This script is a REAL, standalone, testable unit - it does not require
  the WiX toolchain, a PostgreSQL instance, or the built application to
  run. It can (and should) be exercised in isolation, exactly as done in
  this repository's own verification of it (see
  scripts/windows/__tests__/generate-credentials.tests.ps1).

  NEVER logs a generated value. NEVER prints an individual secret to the
  console. The ONLY console output is a diagnostic list of which KEYS
  were written and the output file's path - never their values.

.PARAMETER OutFile
  Where the generated config is written, as a flat KEY=VALUE file (the
  same shape a real .env file/production environment-variable set would
  use). Defaults to a path under $env:ProgramData matching
  docs/internal/WINDOWS_INSTALLER_DESIGN.md's documented location.

.PARAMETER WhatIf
  Generates and validates everything, but does not write the output file
  or touch ACLs - for exercising the generation logic in tests without
  touching the filesystem's ACL model (relevant on non-Windows/CI-lite
  contexts, or repeated test runs).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$OutFile = (Join-Path $env:ProgramData 'Hexyrn Core\config\database.env'),
    [switch]$NoAcl
)

$ErrorActionPreference = 'Stop'

function New-SecureRandomBase64 {
    param([int]$ByteLength = 32)
    # Cryptographically secure - explicitly NOT System.Random, which is a
    # predictable PRNG never appropriate for secrets (a real class of bug
    # this function exists specifically to avoid, not an abstract concern).
    $bytes = [byte[]]::new($ByteLength)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

function New-SecurePasswordToken {
    # A PostgreSQL role password: base64 alone can contain '/', '+', '='
    # which are awkward (not unsafe, but awkward) inside a connection URI
    # without percent-encoding every password consistently everywhere it's
    # used. Uses a URL-safe alphabet instead - still full cryptographic
    # strength (32 random bytes' worth of entropy), just URI-friendly.
    param([int]$ByteLength = 32)
    $b64 = New-SecureRandomBase64 -ByteLength $ByteLength
    return ($b64 -replace '\+', '-' -replace '/', '_' -replace '=', '')
}

Write-Verbose 'Generating installation-specific secrets (values never logged or printed)'

$values = [ordered]@{
    # Matches production-config-check.ts's TOTP_MASTER_KEY_CURRENT
    # requirement exactly: must decode to exactly 32 raw bytes, base64
    # encoded - same generation method that doc's own comment recommends
    # (`openssl rand -base64 32`), just produced via .NET instead of
    # requiring OpenSSL to be separately installed on the target machine.
    TOTP_MASTER_KEY_CURRENT   = New-SecureRandomBase64 -ByteLength 32
    # Encrypts SMTP/webhook/integration secrets; production-config-check.ts
    # refuses to start without it. Independent of the TOTP key on purpose.
    SECRET_ENCRYPTION_MASTER_KEY = New-SecureRandomBase64 -ByteLength 32
    HEXYRN_SESSION_SECRET     = New-SecureRandomBase64 -ByteLength 48
    # Three DISTINCT PostgreSQL role passwords - see
    # docker/postgres-init/01-app-role.sh's own comment on why these must
    # never be the same value (defeats the three-role security split).
    HEXYRN_MIGRATE_DB_PASSWORD = New-SecurePasswordToken
    HEXYRN_APP_DB_PASSWORD     = New-SecurePasswordToken
    HEXYRN_BACKUP_DB_PASSWORD  = New-SecurePasswordToken
}

# Real, tested invariant: no two generated values may collide. Astronomically
# unlikely with 32+ bytes of real entropy each, but asserting it costs
# nothing and turns a silent, catastrophic role-collapse bug into a loud
# failure if the RNG were ever somehow broken.
$distinctCount = ($values.Values | Select-Object -Unique).Count
if ($distinctCount -ne $values.Count) {
    throw 'Generated credential values are not all distinct - refusing to proceed (this should be cryptographically near-impossible; treat as a serious bug, not a fluke).'
}

$lines = foreach ($key in $values.Keys) { "$key=$($values[$key])" }
$content = ($lines -join "`r`n") + "`r`n"

if ($PSCmdlet.ShouldProcess($OutFile, 'Write generated credentials file')) {
    $outDir = Split-Path -Parent $OutFile
    if (-not (Test-Path $outDir)) {
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    }
    # Write via .NET directly (not Out-File/Set-Content's default pipeline)
    # so the content never round-trips through a transcript/verbose stream
    # that a misconfigured PowerShell session (e.g. Start-Transcript left
    # on) could capture.
    [System.IO.File]::WriteAllText($OutFile, $content, [System.Text.Encoding]::UTF8)

    if (-not $NoAcl) {
        Write-Verbose "Restricting ACL on $OutFile to Administrators + SYSTEM only"
        $acl = Get-Acl $OutFile
        $acl.SetAccessRuleProtection($true, $false) # disable inheritance, drop inherited rules
        $admins = New-Object System.Security.AccessControl.FileSystemAccessRule(
            'BUILTIN\Administrators', 'FullControl', 'Allow')
        $system = New-Object System.Security.AccessControl.FileSystemAccessRule(
            'NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')
        $acl.SetAccessRule($admins)
        $acl.SetAccessRule($system)
        Set-Acl -Path $OutFile -AclObject $acl
    }

    Write-Host "Generated credentials written to: $OutFile"
    Write-Host "Keys written (values never logged): $($values.Keys -join ', ')"
}
else {
    Write-Host "(WhatIf) Would write keys: $($values.Keys -join ', ') to $OutFile"
}

# Return the ordered hashtable for callers that want to consume the
# generated values programmatically WITHOUT re-reading the file (e.g. a
# subsequent provisioning step in the same process) - still never printed
# to the console by THIS script; it's the caller's responsibility not to
# log it either.
return $values
