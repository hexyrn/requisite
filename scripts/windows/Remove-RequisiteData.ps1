<#
.SYNOPSIS
  PERMANENTLY deletes all Requisite data on this computer (database, uploaded files, backups, settings).

.DESCRIPTION
  Uninstalling Requisite never deletes your data - it stays in %ProgramData%\Hexyrn Core so a reinstall
  picks up where you left off. Run this only when you truly want to erase everything, for example when
  decommissioning the computer. It refuses to run unless you type DELETE, and it stops the Requisite
  services first. Take a copy of the backups folder first if there is any chance you still need it.
#>
[CmdletBinding()]
param(
    [string]$DataRoot = (Join-Path $env:ProgramData 'Hexyrn Core'),
    [switch]$KeepBackups
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Hexyrn-Common.ps1')
if (-not (Test-IsAdmin)) { throw 'Run this from an elevated (Run as administrator) PowerShell window.' }
if (-not (Test-Path $DataRoot)) { Write-Host "Nothing to delete: $DataRoot does not exist."; return }

Write-Host "This will PERMANENTLY DELETE everything in:`n  $DataRoot" -ForegroundColor Red
Write-Host '  - the database (all organisations, users, requisitions, purchase orders...)'
Write-Host '  - uploaded files'
Write-Host $(if ($KeepBackups) { '  (backups will be kept)' } else { '  - all backups' })
Write-Host '  - settings and encryption keys (data that was encrypted can never be recovered)'
$answer = Read-Host "Type DELETE (in capitals) to continue, anything else cancels"
if ($answer -cne 'DELETE') { Write-Host 'Cancelled. Nothing was deleted.'; return }

foreach ($svc in 'HexyrnCore', 'HexyrnPostgreSQL') {
    if (Get-Service -Name $svc -ErrorAction SilentlyContinue) { Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 3
foreach ($item in Get-ChildItem -Path $DataRoot -Force) {
    if ($KeepBackups -and $item.Name -eq 'backups') { continue }
    Remove-Item -Recurse -Force -Path $item.FullName
}
Write-Host 'All Requisite data has been deleted.'
