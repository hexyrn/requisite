<#
.SYNOPSIS
  Collects what support needs to diagnose a problem into one zip file, with secrets removed.

.DESCRIPTION
  Includes: Windows service status and recent failures, Requisite and database log files, installer logs,
  version information, disk space, and the settings file with every secret value replaced by <redacted>.
  Excludes: the database itself, uploaded files, backups, passwords, keys, and the setup code.
  Run from an elevated PowerShell (the logs are readable by administrators only). The zip is written to the
  current user's Desktop unless -OutFile is given. Review it before sending if you wish - it is a plain zip.
#>
[CmdletBinding()]
param(
    [string]$DataRoot = (Join-Path $env:ProgramData 'Hexyrn Core'),
    [string]$OutFile = (Join-Path ([Environment]::GetFolderPath('Desktop')) ("Requisite-support-$(Get-Date -Format 'yyyyMMdd-HHmmss').zip"))
)
$ErrorActionPreference = 'Stop'

# Values are secret unless the key is on this short list of known-harmless settings.
$safeKeys = 'NODE_ENV', 'HOST', 'PORT', 'ALLOWED_ORIGINS', 'COOKIE_SECURE', 'HEXYRN_PUBLIC_URL', 'HEXYRN_WEB_DIR', 'LOCAL_STORAGE_PATH', 'HEXYRN_BACKUP_DIR', 'PG_DUMP_PATH'

function Protect-Text([string]$text) {
    $t = $text -replace '(postgres(?:ql)?://[^:\s/]+:)[^@\s]+@', '$1<redacted>@'
    $t = $t -replace '(?i)bearer\s+\S+', 'Bearer <redacted>'
    $t = $t -replace '(?i)((?:password|passphrase|secret|token|api[_-]?key|authorization|cookie)["'']?\s*[:=]\s*)("[^"]*"|''[^'']*''|\S+)', '$1<redacted>'
    $t = $t -replace '\b[A-Za-z0-9_-]{43}\b', '<redacted-token>'
    return $t
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ("requisite-support-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
    $info = [ordered]@{
        collectedAt = (Get-Date).ToString('o')
        computer    = $env:COMPUTERNAME
        os          = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture)
        services    = @(Get-Service -Name 'HexyrnCore', 'HexyrnPostgreSQL' -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType)
        disk        = @(Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free)
        listening   = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3000, 5432 } | Select-Object LocalAddress, LocalPort)
        firewall    = @(Get-NetFirewallRule -DisplayName 'Requisite*' -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Direction, Action)
    }
    $info | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'system.json')

    Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = (Get-Date).AddDays(-14) } -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match 'Requisite|Hexyrn' } | Select-Object -First 100 TimeCreated, Id, Message |
        ConvertTo-Json | Set-Content (Join-Path $stage 'service-events.json')

    $logsOut = New-Item -ItemType Directory -Force -Path (Join-Path $stage 'logs')
    $sources = @(
        @{ Dir = (Join-Path $DataRoot 'logs'); Pattern = '*.log' },
        @{ Dir = (Join-Path $DataRoot 'postgresql-data\log'); Pattern = '*.log' },
        @{ Dir = (Join-Path $DataRoot 'postgresql-data'); Pattern = 'startup.log' },
        @{ Dir = $env:TEMP; Pattern = '*Requisite*.log' }
    )
    foreach ($src in $sources) {
        if (-not (Test-Path $src.Dir)) { continue }
        Get-ChildItem -Path $src.Dir -Filter $src.Pattern -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 12 | ForEach-Object {
                $lines = Get-Content -Path $_.FullName -Tail 5000 -ErrorAction SilentlyContinue
                $name = ($_.Directory.Name + '-' + $_.Name)
                Set-Content -Path (Join-Path $logsOut $name) -Value (($lines | ForEach-Object { Protect-Text $_ }) -join "`r`n")
            }
    }

    $envFile = Join-Path $DataRoot 'config\hexyrn.env'
    if (Test-Path $envFile) {
        $redacted = foreach ($line in Get-Content $envFile) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
                if ($safeKeys -contains $Matches[1]) { $line } else { "$($Matches[1])=<redacted>" }
            }
        }
        Set-Content -Path (Join-Path $stage 'settings-redacted.env') -Value $redacted
    }

    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $OutFile
    Write-Host "Support bundle written to: $OutFile"
}
finally {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
