# Testing the Windows installer (Hexyrn internal)

Requisite ships **only** as `Requisite-Setup.exe`. This page says what each layer of testing proves, how to run
it, and what has and has not been executed. **The installer is not production-ready until the clean-VM run below has
been done on real Windows and every check passes.**

## Layers

| Layer                                                                                                          | Where it runs                                  | What it proves                                                                                                                                                                            | What it cannot prove          |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Unit + integration tests (`apps/api`: `npx jest`, `apps/web`: `npx vitest run`)                                | Any OS with PostgreSQL                         | Application logic: auth, MFA, RBAC (incl. "a licence never grants permissions"), licence verification, backups, settings-file loading, static web serving, TLS options, password recovery | Windows packaging             |
| Installer source checks (`node scripts/windows/__tests__/validate-installer-source.js`)                        | Any OS                                         | MSI/WinSW/service wiring rules (real service hosts, accounts, start type, no secrets in the service definition, paths that match the payload layout)                                      | That Windows accepts them     |
| PowerShell script tests (`scripts/windows/__tests__/*.tests.ps1`, `scripts/windows/acceptance/totp.tests.ps1`) | PowerShell 7 (Linux ok)                        | Guards in provisioning, settings helpers, support-bundle redaction, TOTP                                                                                                                  | Windows ACL/service behaviour |
| `scripts/windows/simulate/provision-e2e.sh`                                                                    | Linux, root, PowerShell 7, PostgreSQL 16 shims | The **real** `provision-postgres.ps1`: fresh install → upgrade with a new migration (pre-upgrade dump, secrets untouched, data intact) → repair → both refusal cases                      | Real PostgreSQL 17 on Windows |
| `scripts/windows/simulate/sim-install.sh` + `first-run-journey.js`                                             | Linux                                          | The installed layout run from the settings file only, in a real browser: setup link, licence file, MFA, invitation + RBAC, backup/damage/restore, service restart                         | Windows services, reboot      |
| `scripts/windows/acceptance/Invoke-CleanVmAcceptance.ps1`                                                      | **A clean Windows VM**                         | Everything, on the real thing (see below)                                                                                                                                                 | —                             |

## Clean-VM acceptance run (mandatory before release)

1. Fresh Windows 10/11 or Server 2019/2022 VM with **only Windows** installed, snapshot it.
2. Build the release candidate: `scripts\windows\build-release.ps1 …` (signed with `-Release`, or the
   `Requisite-Setup-UNSIGNED-TEST.exe` for a pre-release rehearsal; the signature check will then fail on purpose).
3. Copy `Requisite-Setup.exe` and `scripts\windows\acceptance\*` to the VM. From an elevated PowerShell:

```
.\Invoke-CleanVmAcceptance.ps1 -Phase Install -Installer C:\drop\Requisite-Setup.exe   # prints the Organisation ID; supply a licence issued for it
# reboot the VM
.\Invoke-CleanVmAcceptance.ps1 -Phase AfterReboot
.\Invoke-CleanVmAcceptance.ps1 -Phase Upgrade -NewInstaller C:\drop\Requisite-Setup-next.exe
.\Invoke-CleanVmAcceptance.ps1 -Phase Uninstall
.\Invoke-CleanVmAcceptance.ps1 -Phase Reinstall -Installer C:\drop\Requisite-Setup.exe
```

4. Do the manual checks the script cannot: watch the browser open after **Launch**, complete the wizard as a
   customer would, choose the licence file in the UI, scan the MFA key with a real authenticator app, run SMTP
   **test send** against a real mail server, and `Enable-LanAccess.ps1 -SelfSigned` from a second machine.
5. Archive `C:\RequisiteAcceptance\evidence.md` / `evidence.json` with the release.

SMTP and encrypted-secret storage: SMTP credentials are stored encrypted with `SECRET_ENCRYPTION_MASTER_KEY`
(covered by the API tests); the VM run confirms the key is generated per install and the settings file is
readable only by Administrators, SYSTEM and the service account.

## Status of execution

See `docs/DEVELOPMENT_STATUS.md` ("Windows deployment") for the dated record of what has been run and what is
outstanding.
