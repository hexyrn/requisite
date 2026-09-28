# Shared helpers for the Requisite admin scripts (dot-sourced; not run directly).

function Get-EnvFileValue {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path $Path)) { return $null }
    foreach ($line in Get-Content -Path $Path) {
        if ($line -match "^\s*$([regex]::Escape($Name))=(.*)$") { return $Matches[1].Trim() }
    }
    return $null
}

# Sets KEY=value in a settings file (replacing an existing line, or appending). Never logs the value.
function Set-EnvFileValue {
    param([string]$Path, [string]$Name, [string]$Value)
    $lines = if (Test-Path $Path) { @(Get-Content -Path $Path) } else { @() }
    $found = $false
    $out = foreach ($line in $lines) {
        if ($line -match "^\s*$([regex]::Escape($Name))=") { $found = $true; "$Name=$Value" } else { $line }
    }
    if (-not $found) { $out = @($out) + "$Name=$Value" }
    [System.IO.File]::WriteAllText($Path, (($out -join "`r`n") + "`r`n"), [System.Text.Encoding]::UTF8)
}

function Remove-EnvFileValue {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path $Path)) { return }
    $out = Get-Content -Path $Path | Where-Object { $_ -notmatch "^\s*$([regex]::Escape($Name))=" }
    [System.IO.File]::WriteAllText($Path, (($out -join "`r`n") + "`r`n"), [System.Text.Encoding]::UTF8)
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Wait-TcpPort {
    param([int]$Port, [int]$TimeoutSeconds = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $c.Connect('127.0.0.1', $Port)
            $c.Close()
            return $true
        }
        catch { Start-Sleep -Seconds 2 }
    }
    return $false
}
