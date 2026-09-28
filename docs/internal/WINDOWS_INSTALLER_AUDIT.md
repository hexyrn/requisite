# Windows installer audit (Hexyrn internal)

Scope: everything a customer receives (`Requisite-Setup-<version>.exe`, `Requisite-<version>.msi`) and how it is
built. Docker is not part of the customer deployment and none of the customer-facing assets mention it (enforced by
`scripts/windows/__tests__/validate-customer-assets.js`).

**Verdict: NOT production-ready.** All static, build-authoring and logic checks pass, but the clean-VM run has not
been executed (see `WINDOWS_TESTING.md`). Open blockers are listed at the end.

## Findings and what was done

| #   | Area              | Finding (root cause)                                                                                                   | Fix                                                                                                                                                                                 | Verified by                                                                 |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Runtime           | The database engine needs the Microsoft C++ runtime, absent on clean Windows; install would have failed at first start | Burn bundle installs the Microsoft C++ 2015-2022 runtime first (skipped when a new-enough one exists); build verifies Microsoft's signature                                         | WiX compile + bundle checks; **needs VM**                                   |
| 2   | Runtime           | Build only warned when no Node runtime was supplied, producing an MSI that depended on a customer-installed Node       | Node, C++ runtime and PostgreSQL are mandatory build inputs; `-FetchInputs` downloads them and checks pinned SHA-256 (Node and WinSW hashes re-verified against the real downloads) | script checks                                                               |
| 3   | Success reporting | Nothing proved the product actually ran before "success"                                                               | `Verify-Install.ps1` runs after services start; waits for both services + health; on failure writes a redacted `install-failure.txt` and fails, so Windows Installer rolls back     | PowerShell parse, 5.1-syntax check; **needs VM**                            |
| 4   | Partial installs  | A failure mid-provisioning left a half-built database and credentials that blocked a retry                             | Provisioning removes exactly what the failed run created (never runs when data/settings pre-exist); port pre-checks give a clear message before anything is created                 | `provision-e2e.sh` section 0 (occupied port, broken migration, clean retry) |
| 5   | Upgrade           | Failed migration left no guidance                                                                                      | Update stops, names the pre-upgrade database copy; data proven unchanged                                                                                                            | `provision-e2e.sh` section 5                                                |
| 6   | Startup           | App exited if the database service was still starting after reboot, causing restart loops                              | App waits (backoff, up to 5 min) for the database before starting; clear error on timeout                                                                                           | unit test with fake clock                                                   |
| 7   | Privilege         | Custom actions ran `powershell/cmd/icacls/netsh` by bare name as SYSTEM (search-path hijack risk)                      | All start system tools by absolute `[System64Folder]` path; validator enforces it                                                                                                   | validator                                                                   |
| 8   | Bug               | Data-removal command ended in `"...\"` (trailing-backslash trap) so the quote was swallowed                            | Uses `[Folder].` form; validator forbids the pattern                                                                                                                                | validator                                                                   |
| 9   | Permissions       | Data root inherited ProgramData defaults (users could create files next to config)                                     | Root is Administrators/SYSTEM full, Users read-only; sub-folders keep their own stricter ACLs                                                                                       | validator; **ACLs need VM**                                                 |
| 10  | Firewall          | Optional LAN rule was never removed on uninstall                                                                       | Removal action on uninstall; installer itself never creates a rule                                                                                                                  | validator                                                                   |
| 11  | Leaks             | Customer-visible errors quoted internal file names / variables; installed scripts mentioned Docker                     | Rewritten in plain language pointing at Repair/support; comments cleaned                                                                                                            | validator                                                                   |
| 12  | Licence UX        | Verifier messages were technical                                                                                       | Plain-language reasons (damaged file / not issued by Hexyrn / wrong organisation / wrong product / wrong version)                                                                   | unit + integration tests                                                    |
| 13  | Branding          | No icon, licence agreement, publisher/help links, or product-name consistency ("Hexyrn Core" in Start menu/strings)    | Icon, EULA page, Programs & Features metadata, "Requisite" everywhere customer-visible, per-machine Start Menu entry                                                                | validator; **look needs VM**                                                |
| 14  | OS support        | No OS gate                                                                                                             | Launch condition: 64-bit Windows 10 / 11 / Server 2019+                                                                                                                             | validator                                                                   |
| 15  | Versioning        | Version was a hard-coded default                                                                                       | One source (repository version), agreement of the three package versions enforced, stamped into `version.json`, shown in the support bundle                                         | validator                                                                   |
| 16  | Outputs           | Loose files in `dist-release`, no checksums                                                                            | `dist/Requisite-Setup-<v>.exe`, `Requisite-<v>.msi`, `checksums.txt`; unsigned builds are visibly named `-UNSIGNED-TEST`; `-Release` requires signing                               | validator                                                                   |
| 17  | Validation        | WiX could not check references on Linux (compiler stops at path artefacts)                                             | Own reference/duplicate-Id checker plus a compile filter with self-tests (deliberate defects must be caught)                                                                        | `wix-compile-check.sh --self-test`                                          |
| 18  | Compatibility     | Scripts were only tested in PowerShell 7 but run in Windows PowerShell 5.1                                             | Static scan for 6+/7-only syntax in every packaged script                                                                                                                           | validator (with negative test)                                              |

Earlier rounds (already in place): real service hosts (WinSW + `pg_ctl runservice`) under virtual service accounts;
secrets generated per install and ACL-restricted; public-key-only licensing; upgrade preserves settings/secrets and
takes a database copy first; uninstall keeps data; typed-`DELETE` data removal tool; optional HTTPS/LAN tool;
redacted support bundle; setup code in the URL fragment and never in logs.

## Decisions

- **Install location screen:** not offered. Program files go to `C:\Program Files\Hexyrn Core` and data to
  `C:\ProgramData\Hexyrn Core`; fewer choices, no support cases about relocated data. Revisit only on customer demand.
- **PostgreSQL:** bundled, private (loopback only, own port 55432, own Windows service, own virtual account), fully
  managed by the installer and the app. No customer administration.
- **Desktop shortcut:** none (Start menu entry only).
- **`-ExecutionPolicy Bypass`:** used only for installer-owned scripts in `Program Files`, which only administrators can write.

## Open blockers before a public release

P0

1. Clean-VM acceptance run on real Windows 10 and 11 has not been executed (install, reboot, service recovery, upgrade,
   uninstall, reinstall, repair, MFA/SMTP with real apps).
2. No signed build: Hexyrn must obtain a code-signing certificate (`WINDOWS_SIGNING.md`).
3. The licence agreement is a placeholder and must be replaced by Hexyrn's counsel-approved text.
4. The MSI/bundle have been schema/link-checked only on Linux; the first real Windows build will probably surface
   authoring issues (previous real builds compiled, but the service rework and bundle changes have not been built there).

P1 5. Friendly pre-flight dialogs (port taken, existing service name clash) need a custom bootstrapper UI; today the
failure is caught and explained in the installer log and `install-failure.txt`, and the install rolls back. 6. Web port cannot be changed after install from the UI (Start Menu shortcut assumes the installed port). 7. Antivirus/EDR behaviour with the bundled `postgres.exe`/`node.exe` and the PowerShell custom actions is untested. 8. Offline behaviour: installer is self-contained (no downloads at install time) - to be confirmed on a VM without network.
