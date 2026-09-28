<#
.SYNOPSIS
  Acceptance test for Requisite-Setup.exe on a CLEAN Windows machine (a fresh VM with only Windows installed).

.DESCRIPTION
  Run from an elevated PowerShell on the VM. It drives one phase at a time and writes every result, with the
  evidence behind it, to C:\RequisiteAcceptance\evidence.json and evidence.md so the outcome can be reviewed and
  archived. A phase that cannot prove something fails; nothing is assumed.

  Phases (in order):
    Install     preflight (nothing developer-ish installed), silent install, services/accounts/ACLs/ports/firewall,
                first-run setup, licence, MFA, second user + RBAC, data, backup, damage, restore
    AfterReboot run after rebooting the VM: services came up alone; sign in with MFA; data still there;
                kill the app service and prove it restarts by itself
    Upgrade     install -NewInstaller over the top: data, licence, MFA, users kept; pre-upgrade backup exists
    Uninstall   silent uninstall: services and program files gone, data and backups KEPT
    Reinstall   install again: previous organisation, users and data are back; repair (msiexec /f) keeps identity
    Purge       optional: delete all data with Remove-RequisiteData.ps1 (interactive DELETE)

  Licence: the licence is issued on Hexyrn's side for this installation's Organisation ID, so the Install phase prints
  the ID and then waits for a licence file path (or pass -LicenceFile if one was issued in advance for a re-test).

.EXAMPLE
  .\Invoke-CleanVmAcceptance.ps1 -Phase Install -Installer C:\drop\Requisite-Setup.exe
  (reboot)
  .\Invoke-CleanVmAcceptance.ps1 -Phase AfterReboot
  .\Invoke-CleanVmAcceptance.ps1 -Phase Upgrade -Installer C:\drop\Requisite-Setup-2.exe
  .\Invoke-CleanVmAcceptance.ps1 -Phase Uninstall
  .\Invoke-CleanVmAcceptance.ps1 -Phase Reinstall -Installer C:\drop\Requisite-Setup.exe

  Against a Linux simulation (API checks only, Windows checks skipped):
  pwsh Invoke-CleanVmAcceptance.ps1 -Phase ApiOnly -BaseUrl http://localhost:3000 -SetupTokenFile <token file> -LicenceFile <file>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Install', 'AfterReboot', 'Upgrade', 'Uninstall', 'Reinstall', 'Purge', 'ApiOnly')][string]$Phase,
    [string]$Installer,
    [string]$NewInstaller,
    [string]$LicenceFile,
    # Optional: a script that is given the Organisation ID and returns the path of a licence issued for it (automation / simulation).
    [string]$LicenceCommand,
    [string]$BaseUrl = 'http://localhost:3000',
    [string]$SetupTokenFile,
    [string]$EvidenceDir = 'C:\RequisiteAcceptance'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'RequisiteApi.ps1')
$isWin = $env:OS -eq 'Windows_NT'
$DataRoot = if ($isWin) { Join-Path $env:ProgramData 'Hexyrn Core' } else { $null }
if (-not $isWin) { $EvidenceDir = Join-Path ([IO.Path]::GetTempPath()) 'RequisiteAcceptance' }
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$evidenceFile = Join-Path $EvidenceDir 'evidence.json'
$stateFile = Join-Path $EvidenceDir 'state.json'
$evidence = @(if (Test-Path $evidenceFile) { Get-Content $evidenceFile -Raw | ConvertFrom-Json })
$state = if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
$failures = 0

function Save-State { $state | ConvertTo-Json | Set-Content $stateFile }
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $script:evidence += [pscustomobject]@{ phase = $Phase; time = (Get-Date).ToString('s'); check = $Name; passed = $Ok; detail = $Detail }
    if ($Ok) { Write-Host "PASS  $Name" -ForegroundColor Green } else { Write-Host "FAIL  $Name  $Detail" -ForegroundColor Red; $script:failures++ }
    $script:evidence | ConvertTo-Json -Depth 4 | Set-Content $evidenceFile
}
function Wait-Health([int]$Seconds = 120) {
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) { try { if ((Invoke-WebRequest "$BaseUrl/api/v1/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }; Start-Sleep 2 }
    $false
}
function Install-Requisite([string]$Path) {
    $log = Join-Path $EvidenceDir "install-$(Get-Date -Format 'HHmmss').log"
    $p = Start-Process -FilePath $Path -ArgumentList '/quiet', '/norestart', '/log', "`"$log`"" -Wait -PassThru
    Check "installer exit code 0 or 3010 ($([IO.Path]::GetFileName($Path)))" ($p.ExitCode -in 0, 3010) "exit=$($p.ExitCode) log=$log"
}
function Get-ServiceFacts {
    foreach ($n in 'HexyrnPostgreSQL', 'HexyrnCore') {
        $svc = Get-CimInstance Win32_Service -Filter "Name='$n'" -ErrorAction SilentlyContinue
        [pscustomobject]@{ Name = $n; Exists = [bool]$svc; State = $svc.State; StartMode = $svc.StartMode; Account = $svc.StartName }
    }
}
function Sign-In($session, [string]$email, [string]$password, [string]$totpSecret) {
    $r = Invoke-RqApi $session POST '/auth/login' @{ email = $email; password = $password }
    $session.Csrf = $r.Body.csrfToken
    if ($r.Body.requiresMfa) {
        $code = Get-Totp $totpSecret
        $v = Invoke-RqApi $session POST '/auth/mfa/verify' @{ code = $code } -AllowError
        if ($v.Status -ge 400) { Start-Sleep 31; $v = Invoke-RqApi $session POST '/auth/mfa/verify' @{ code = (Get-Totp $totpSecret) } }
        $session.Csrf = $v.Body.csrfToken
    }
}
$OwnerEmail = 'owner@acceptance.test'; $OwnerPassword = 'Acceptance-Owner-Passw0rd!'
$StaffEmail = 'staff@acceptance.test'; $StaffPassword = 'Acceptance-Staff-Passw0rd!'
$Licence = 'com.hexyrn.requisite'

function Test-InstalledFootprint {
    $f = Get-ServiceFacts
    foreach ($s in $f) {
        Check "service $($s.Name) exists, Automatic, Running" ($s.Exists -and $s.StartMode -eq 'Auto' -and $s.State -eq 'Running') ($s | ConvertTo-Json -Compress)
        Check "service $($s.Name) runs as a virtual service account (not SYSTEM/Administrator)" ($s.Account -like 'NT SERVICE\*') $s.Account
    }
    $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3000, 5432, 55432 })
    Check 'nothing is reachable from the network by default (only loopback listeners on 3000 / PostgreSQL)' (-not ($listen | Where-Object { $_.LocalAddress -notin '127.0.0.1', '::1' })) (($listen | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ', ')
    Check 'no Windows Firewall rule was opened' (-not (Get-NetFirewallRule -DisplayName 'Requisite*' -ErrorAction SilentlyContinue))
    $acl = (Get-Acl (Join-Path $DataRoot 'config')).Access | ForEach-Object { $_.IdentityReference.Value }
    Check 'settings folder is not readable by ordinary users' (-not ($acl -match 'BUILTIN\\Users|Everyone|Authenticated Users')) ($acl -join '; ')
    $pg = Get-Content (Join-Path $DataRoot 'postgresql-data\postgresql.conf') -Raw
    Check 'PostgreSQL listens on localhost only' ($pg -match "listen_addresses = 'localhost'")
    Check 'Start Menu entry exists' ([bool](Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter 'Requisite*.lnk' -ErrorAction SilentlyContinue))
}

function Test-ApiJourney {
    $owner = New-RqSession $BaseUrl
    $tokenFile = if ($SetupTokenFile) { $SetupTokenFile } else { Join-Path $DataRoot 'config\bootstrap-token.txt' }
    Check 'first-run setup code file exists and is not world-readable' ((Test-Path $tokenFile) -and ($isWin -eq $false -or -not ((Get-Acl $tokenFile).Access.IdentityReference.Value -match 'Users|Everyone'))) $tokenFile
    $token = (Get-Content $tokenFile -TotalCount 1).Trim()
    $done = Invoke-RqApi $owner POST '/bootstrap/complete' @{ token = $token; organisationName = 'Acceptance Ltd'; organisationDisplayName = 'Acceptance'; defaultCurrency = 'GBP'; timezone = 'Europe/London'; locale = 'en-GB'; financialYearStartMonth = 4; ownerEmail = $OwnerEmail; ownerPassword = $OwnerPassword }
    Check 'organisation and Owner created by setup' ($done.Status -in 200, 201)
    Check 'setup code file is deleted after setup' (-not (Test-Path $tokenFile))
    Sign-In $owner $OwnerEmail $OwnerPassword $null
    $lic = Invoke-RqApi $owner GET "/apps/$Licence/licence"
    $org = $lic.Body.organisationId
    Check 'Organisation ID is available to quote to Hexyrn' ([bool]$org) $org
    Check 'Requisite is NOT usable before a licence' ((Invoke-RqApi $owner GET '/requisite/suppliers' -AllowError).Status -ge 400)
    if (-not $LicenceFile -and $LicenceCommand) { $LicenceFile = (& $LicenceCommand $org | Select-Object -Last 1) }
    if (-not $LicenceFile) {
        Write-Host "`nOrganisation ID: $org`nIssue a licence for it on Hexyrn's side (npm run licence -- issue --org $org ...), copy the file here." -ForegroundColor Yellow
        $LicenceFile = Read-Host 'Path to the licence file'
    }
    # The licence file is sent exactly as issued (never re-serialised: that could alter what was signed).
    $licRaw = (Get-Content $LicenceFile -Raw).Trim()
    $licMajor = [int]([regex]::Match($licRaw, '"majorVersion"\s*:\s*(\d+)').Groups[1].Value)
    function Get-LicenceBody([string]$raw) { "{`"majorVersion`":$licMajor,`"licence`":$raw}" }
    $imp = Invoke-RqApi $owner POST "/apps/$Licence/licence" -RawJson (Get-LicenceBody $licRaw) -AllowError
    Check 'a valid licence is accepted and activates Requisite' ($imp.Status -in 200, 201) "status=$($imp.Status)"
    $tampered = $licRaw.Replace($org, [guid]::NewGuid().ToString())
    $bad = Invoke-RqApi $owner POST "/apps/$Licence/licence" -RawJson (Get-LicenceBody $tampered) -AllowError
    Check 'a licence for a different organisation (tampered) is rejected' (($tampered -ne $licRaw) -and $bad.Status -ge 400) "status=$($bad.Status)"
    Check 'Owner can use Requisite after activation' ((Invoke-RqApi $owner GET '/requisite/suppliers').Status -eq 200)

    # MFA
    $begin = Invoke-RqApi $owner POST '/auth/mfa/enroll/begin'
    $secret = $begin.Body.secret
    $confirm = Invoke-RqApi $owner POST '/auth/mfa/enroll/confirm' @{ secret = $secret; code = (Get-Totp $secret) }
    Check 'MFA enrolment works and returns one-time recovery codes' ($confirm.Body.enabled -and $confirm.Body.recoveryCodes.Count -ge 8)
    $state.totpSecret = $secret; $state.recoveryCodes = @($confirm.Body.recoveryCodes); $state.org = $org; Save-State
    $again = New-RqSession $BaseUrl
    $first = Invoke-RqApi $again POST '/auth/login' @{ email = $OwnerEmail; password = $OwnerPassword }
    Check 'sign-in now requires a second factor' ($first.Body.requiresMfa -eq $true)
    Check 'a wrong code is refused' ((Invoke-RqApi $again POST '/auth/mfa/verify' @{ code = '000000' } -AllowError).Status -ge 400)
    $owner = New-RqSession $BaseUrl; Sign-In $owner $OwnerEmail $OwnerPassword $secret
    Check 'sign-in with a correct code works' ((Invoke-RqApi $owner GET '/auth/session').Status -eq 200)

    # user management + RBAC
    $roles = (Invoke-RqApi $owner GET '/roles').Body.roles
    $req = $roles | Where-Object { $_.name -like '*Requester*' } | Select-Object -First 1
    Check 'starter roles exist after activation' ([bool]$req)
    $inv = Invoke-RqApi $owner POST '/auth/invitations' @{ email = $StaffEmail; roleIds = @($req.id) }
    Check 'invitation link includes the port (usable as-is)' ($inv.Body.invitationUrlForAdmin -match '^https?://[^/]+:\d+/setup/accept-invitation\?token=' -or $BaseUrl -notmatch ':\d+$') $inv.Body.invitationUrlForAdmin
    $tok = ([uri]$inv.Body.invitationUrlForAdmin).Query -replace '^\?token=', ''
    Invoke-RqApi (New-RqSession $BaseUrl) POST '/auth/invitations/accept' @{ token = $tok; password = $StaffPassword } | Out-Null
    $staff = New-RqSession $BaseUrl; Sign-In $staff $StaffEmail $StaffPassword $null
    Check 'RBAC: Requester may view requisitions' ((Invoke-RqApi $staff GET '/requisite/requisitions').Status -eq 200)
    Check 'RBAC: Requester may NOT manage suppliers' ((Invoke-RqApi $staff POST '/requisite/suppliers' @{ name = 'x' } -AllowError).Status -eq 403)
    Check 'RBAC: Requester may NOT list users or import a licence' (((Invoke-RqApi $staff GET '/users' -AllowError).Status -eq 403) -and ((Invoke-RqApi $staff POST "/apps/$Licence/licence" -RawJson (Get-LicenceBody $licRaw) -AllowError).Status -eq 403))

    # data, backup, damage, restore
    $sup = Invoke-RqApi $owner POST '/requisite/suppliers' @{ name = 'Acceptance Supplier Ltd' }
    Check 'business data can be created' ($sup.Status -in 200, 201)
    $bk = Invoke-RqApi $owner POST '/backup'
    Check 'Backup Now succeeds' ($bk.Status -in 200, 201) $bk.Body.backupId
    $state.backupId = $bk.Body.backupId; Save-State
    if ($isWin) {
        Check 'the backup is on disk under ProgramData (survives uninstall)' (Test-Path (Join-Path $DataRoot "backups\$($bk.Body.backupId)"))
        $psql = Join-Path ${env:ProgramFiles} 'Hexyrn Core\postgresql\bin\psql.exe'
        $envText = Get-Content (Join-Path $DataRoot 'config\hexyrn.env') -Raw
        $url = [regex]::Match($envText, '(?m)^BACKUP_DATABASE_URL=(.*)$').Groups[1].Value.Trim()
        & $psql $url -q -c "DELETE FROM requisite_suppliers WHERE name='Acceptance Supplier Ltd'" | Out-Null
        Check 'simulated data loss is visible' (-not ((Invoke-RqApi $owner GET '/requisite/suppliers').Body | ConvertTo-Json -Depth 6 | Select-String 'Acceptance Supplier'))
        $rs = Invoke-RqApi $owner POST "/backup/$($bk.Body.backupId)/restore" @{ confirmed = $true } -AllowError
        Check 'Restore from the app brings the data back' ($rs.Status -in 200, 201) "status=$($rs.Status)"
        $owner = New-RqSession $BaseUrl; Sign-In $owner $OwnerEmail $OwnerPassword $secret
        Check 'restored data is present' (($owner | ForEach-Object { (Invoke-RqApi $_ GET '/requisite/suppliers').Body | ConvertTo-Json -Depth 6 }) -match 'Acceptance Supplier')
    }
    $state.staffEmail = $StaffEmail; Save-State
}

function Test-SignInAndData {
    $s = New-RqSession $BaseUrl
    Sign-In $s $OwnerEmail $OwnerPassword $state.totpSecret
    Check 'Owner can sign in with MFA' ((Invoke-RqApi $s GET '/auth/session').Status -eq 200)
    Check 'organisation is the same one as before (identity preserved)' ((Invoke-RqApi $s GET "/apps/$Licence/licence").Body.organisationId -eq $state.org)
    Check 'licence is still active' ((Invoke-RqApi $s GET "/apps/$Licence/licence").Body.active -eq $true)
    Check 'business data is still there' (((Invoke-RqApi $s GET '/requisite/suppliers').Body | ConvertTo-Json -Depth 6) -match 'Acceptance Supplier')
    $st = New-RqSession $BaseUrl; Sign-In $st $StaffEmail $StaffPassword $null
    Check 'the invited user still exists and is still restricted' ((Invoke-RqApi $st POST '/requisite/suppliers' @{ name = 'y' } -AllowError).Status -eq 403)
}

switch ($Phase) {
    'ApiOnly' { Test-ApiJourney }
    'Install' {
        if (-not $isWin) { throw 'Install phase needs Windows.' }
        if (-not $Installer) { throw '-Installer is required' }
        $id = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        Check 'running elevated' $id.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        $os = Get-CimInstance Win32_OperatingSystem
        Check "clean-machine OS recorded: $($os.Caption) $($os.Version)" $true
        foreach ($tool in 'node', 'npm', 'docker', 'git', 'psql', 'postgres') { Check "'$tool' is NOT installed (customer machine has no developer tools)" (-not (Get-Command $tool -ErrorAction SilentlyContinue)) }
        Check 'no PostgreSQL / Docker services pre-exist' (-not (Get-Service | Where-Object { $_.Name -match 'postgres|docker' }))
        Check 'installer is Authenticode-signed (release builds only; expected FAIL for -UNSIGNED-TEST)' ((Get-AuthenticodeSignature $Installer).Status -eq 'Valid') (Get-AuthenticodeSignature $Installer).Status
        Install-Requisite $Installer
        Check 'service starts and answers within 2 minutes' (Wait-Health)
        Test-InstalledFootprint
        Test-ApiJourney
        Write-Host "`nNow REBOOT the VM, then run:  .\Invoke-CleanVmAcceptance.ps1 -Phase AfterReboot" -ForegroundColor Yellow
    }
    'AfterReboot' {
        Check 'services came up by themselves after the reboot' (Wait-Health 300)
        Test-InstalledFootprint
        Test-SignInAndData
        $before = (Get-CimInstance Win32_Service -Filter "Name='HexyrnCore'").ProcessId
        Stop-Process -Id $before -Force
        Check 'after the app process is killed, Windows restarts it by itself' (Wait-Health 120) "old pid $before"
        $before2 = (Get-CimInstance Win32_Service -Filter "Name='HexyrnPostgreSQL'").ProcessId
        Stop-Process -Id $before2 -Force
        Start-Sleep 5
        Check 'after the database process is killed, the database and the app recover' (Wait-Health 180)
        Test-SignInAndData
    }
    'Upgrade' {
        if (-not $NewInstaller -and -not $Installer) { throw '-NewInstaller is required' }
        $before = @(Get-ChildItem (Join-Path $DataRoot 'backups') -Filter 'pre-upgrade-*.dump' -ErrorAction SilentlyContinue).Count
        $envHash = (Get-FileHash (Join-Path $DataRoot 'config\hexyrn.env')).Hash
        Install-Requisite $(if ($NewInstaller) { $NewInstaller } else { $Installer })
        Check 'service is back after the upgrade' (Wait-Health 180)
        Check 'a database backup was taken before the upgrade' (@(Get-ChildItem (Join-Path $DataRoot 'backups') -Filter 'pre-upgrade-*.dump').Count -gt $before)
        Check 'secrets and settings were preserved (hexyrn.env unchanged)' ((Get-FileHash (Join-Path $DataRoot 'config\hexyrn.env')).Hash -eq $envHash)
        Test-InstalledFootprint
        Test-SignInAndData
    }
    'Uninstall' {
        $product = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Requisite' } | Select-Object -First 1
        Check 'Requisite is listed in Apps & features' ([bool]$product)
        $p = Start-Process msiexec.exe -ArgumentList '/x', $product.PSChildName, '/quiet', '/norestart' -Wait -PassThru
        Check 'uninstall exit code 0' ($p.ExitCode -in 0, 3010) "exit=$($p.ExitCode)"
        Check 'services are removed' (-not (Get-Service -Name 'HexyrnCore', 'HexyrnPostgreSQL' -ErrorAction SilentlyContinue))
        Check 'program files are removed' (-not (Test-Path (Join-Path $env:ProgramFiles 'Hexyrn Core\node')))
        Check 'DATA is kept: database folder' (Test-Path (Join-Path $DataRoot 'postgresql-data\PG_VERSION'))
        Check 'DATA is kept: backups' (@(Get-ChildItem (Join-Path $DataRoot 'backups') -ErrorAction SilentlyContinue).Count -gt 0)
        Check 'DATA is kept: settings' (Test-Path (Join-Path $DataRoot 'config\hexyrn.env'))
    }
    'Reinstall' {
        if (-not $Installer) { throw '-Installer is required' }
        Install-Requisite $Installer
        Check 'service starts against the kept data' (Wait-Health 180)
        Test-SignInAndData
        $msi = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Requisite' } | Select-Object -First 1).PSChildName
        $h = (Get-FileHash (Join-Path $DataRoot 'config\hexyrn.env')).Hash
        $p = Start-Process msiexec.exe -ArgumentList '/f', $msi, '/quiet', '/norestart' -Wait -PassThru
        Check 'repair (msiexec /f) completes' ($p.ExitCode -in 0, 3010) "exit=$($p.ExitCode)"
        Check 'repair keeps identity: settings unchanged, service healthy, data present' ((Wait-Health 180) -and ((Get-FileHash (Join-Path $DataRoot 'config\hexyrn.env')).Hash -eq $h))
        Test-SignInAndData
    }
    'Purge' {
        Write-Host 'Run:  & "$env:ProgramFiles\Hexyrn Core\scripts\Remove-RequisiteData.ps1"  and type DELETE. Then re-run -Phase Reinstall to prove a clean start.'
    }
}

$md = @('# Requisite clean-VM acceptance evidence', '', "Machine: $env:COMPUTERNAME  -  generated $(Get-Date -Format s)", '', '| Phase | Check | Result | Detail |', '|---|---|---|---|')
$md += $evidence | ForEach-Object { "| $($_.phase) | $($_.check) | $(if ($_.passed) { 'PASS' } else { '**FAIL**' }) | $($_.detail) |" }
Set-Content (Join-Path $EvidenceDir 'evidence.md') $md
Write-Host "`n$(@($evidence | Where-Object passed).Count) passed, $failures failed in this run. Evidence: $EvidenceDir"
if ($failures) { exit 1 }
