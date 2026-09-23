# Windows Acceptance Preparation

**Status: preparation only.** Nothing in this document has been executed
- there is no WiX toolchain, no Windows GUI session, and no Windows
Sandbox/VM available in this sandboxed environment (confirmed directly:
`candle.exe`/`light.exe`/`wix.exe` all absent from `PATH`). This
document exists so the exact steps are ready to run on a real Windows
machine, not to claim they have passed. **The Windows installer has NOT
been built. The clean-machine acceptance test has NOT been run on
Windows. RC1 is NOT declared ready.**

## Prerequisites (once, on the Windows build/test machine)

- Windows 10/11 or Windows Server 2019+, with Developer Mode or an
  admin account (WiX and service installation both need elevated
  privileges).
- .NET SDK 6.0+ (`dotnet --version`) - required to install the WiX
  Toolset v4 as a global tool.
- Node.js 20.x and npm (matching this repository's `engines.node`
  constraint in `package.json`) - to build Hexyrn Core/Requisite.
- Git, to clone/pull this repository.
- (For step 5) Windows Sandbox enabled (`Optional Features` →
  "Windows Sandbox" - Windows 10/11 Pro/Enterprise only) OR a
  Hyper-V/VirtualBox VM with a clean Windows install and no prior
  Hexyrn state.
- A code-signing certificate for the installer artifact itself (a
  real, separate acquisition - not addressed further here; an unsigned
  `.msi` will trigger SmartScreen warnings and is not appropriate for a
  genuine customer-facing RC1 build).

## 1. Install the WiX toolchain

```powershell
dotnet tool install --global wix
wix --version   # confirm it installed
wix extension add WixToolset.Util.wixext
wix extension add WixToolset.Bal.wixext   # needed for the Burn bundle (uninstall data-retention UI)
```

## 2. Build Hexyrn Core + Requisite RC1

From the repository root:

```powershell
npm ci
npm run build   # builds every workspace: packages/shared-types, packages/app-sdk,
                # packages/design-system, apps/api, apps/web
```

Confirm the real build outputs exist before packaging:

```powershell
dir apps\api\dist\main.js
dir apps\web\dist\index.html
dir packages\app-sdk\dist\index.js
dir packages\shared-types\dist\index.js
```

Run the full verification suite one more time on THIS machine before
packaging anything (do not trust a prior machine's results for the
artifact you're about to sign and ship):

```powershell
npm run typecheck
npm run lint
cd apps\api; npx jest --runInBand; cd ..\..
cd apps\web; npx vitest run; cd ..\..
```

`apps\api`'s Jest suite needs a real PostgreSQL instance reachable via
`TEST_DATABASE_URL` (see `.env.example`) - install PostgreSQL 17
natively on this build machine for this step specifically (this is
testing the BUILD, not the bundled-Postgres installer's own behavior,
which is a separate, later verification once the installer's Postgres-
bundling components are built per `docs/WINDOWS_INSTALLER_DESIGN.md`).

## 3. Build the Windows installer

**Not yet fully buildable** - `installer/windows/Product.wxs` needs two
things added first, both flagged as `TODO` comments directly in that
file:
1. Real file harvesting of `apps/api/dist`/`node_modules`/
   `packages/*/dist` into the `ApiFiles` component group (`wix build`
   supports directory harvesting - do not hand-enumerate).
2. The bundled-PostgreSQL components described in
   `docs/WINDOWS_INSTALLER_DESIGN.md` (a second `ServiceInstall`, the
   `initdb`/role-creation custom actions, the PostgreSQL data directory).

Once those are added, the actual build command (WiX v4 syntax):

```powershell
wix build installer\windows\Product.wxs `
  -d HexyrnVersion=1.0.0-rc1 `
  -d ApiDistPath=apps\api\dist `
  -ext WixToolset.Util.wixext `
  -ext WixToolset.Bal.wixext `
  -out dist-release\HexyrnCore-1.0.0-rc1.msi
```

(The Burn bundle wrapping this `.msi` for the uninstall data-retention
UI is a separate `.wxs`/build step, not yet written - see
`docs/WINDOWS_INSTALLER_DESIGN.md`'s "Uninstall / data retention"
section.)

## 4. Verify the artifact / signature

```powershell
# Code-sign the built MSI (requires the real signing certificate):
signtool sign /f <path-to-cert.pfx> /p <cert-password> /fd sha256 /tr http://timestamp.digicert.com /td sha256 dist-release\HexyrnCore-1.0.0-rc1.msi
signtool verify /pa dist-release\HexyrnCore-1.0.0-rc1.msi

# Generate the release manifest with the REAL production signing key
# (never the default test key - see generate-release-manifest.ts's own
# loud warning if you forget --signing-key-pem-file):
cd apps\api
npx ts-node scripts\generate-release-manifest.ts `
  --artifact ..\dist-release\HexyrnCore-1.0.0-rc1.msi `
  --product-id hexyrn-core `
  --version 1.0.0-rc1 `
  --requires-core-version ">=1.0.0-rc1" `
  --artifact-type windows-installer `
  --signing-key-pem-file <path-to-real-release-signing-private-key.pem> `
  --signing-key-id <real-key-id> `
  --out ..\dist-release\HexyrnCore-1.0.0-rc1.manifest.json
cd ..\..
```

## 5. Launch Windows Sandbox/VM

Windows Sandbox (fast, disposable, built into Windows 10/11 Pro):

```powershell
# From an elevated PowerShell, enable it once if not already:
Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All
# Then just launch:
WindowsSandbox.exe
```

Or a Hyper-V VM from a clean Windows ISO, snapshotted BEFORE any Hexyrn
installation so the acceptance test can be re-run repeatedly from a
genuinely clean state.

## 6. Transfer only the release artifact and acceptance harness

Deliberately NOT the whole repository - the point of this step is
proving what a REAL CUSTOMER receives installs and works, not that "the
dev environment can run it":

- `dist-release\HexyrnCore-1.0.0-rc1.msi`
- `dist-release\HexyrnCore-1.0.0-rc1.manifest.json`
- A copy of `docs/OPERATOR_GUIDE.md` (what a real customer would read)
- The acceptance checklist below (this document, or a printed/copied
  version of it)

Windows Sandbox supports drag-and-drop from the host, or a mapped
folder via its config XML's `<MappedFolders>` - use a READ-ONLY mapping
for the artifact so the sandbox environment can't accidentally write
back into the host's build output.

## 7. Execute the clean-machine acceptance test

Inside the clean sandbox/VM, WITHOUT installing Node.js, PostgreSQL, or
anything else the installer itself should be providing (that's exactly
what's being tested - a real SME administrator's machine):

1. Run the signed `.msi`. Confirm: PostgreSQL 17 installs, initializes,
   and starts as its own Windows Service; the three Postgres roles
   (`hexyrn`/`hexyrn_app`/`hexyrn_backup`) are created with the correct
   privileges (verify via `psql` from the bundled `bin\` directory -
   `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname
   LIKE 'hexyrn%'` should show exactly the same three-row result this
   phase already proved in Docker); migrations run; the Hexyrn Core
   Windows Service starts and is reachable at `https://localhost/`
   (or whatever port/TLS the installer configures).
2. Complete first-run bootstrap (`docs/OPERATOR_GUIDE.md`).
3. Run through the SAME sequence
   `clean-machine-harness.integration.spec.ts` automates against this
   sandbox's Postgres, but for REAL through the actual installed
   application and browser: create an organisation/owner, invite a
   second user, create/submit/approve a requisition, generate/issue a
   PO, record a goods receipt.
4. Take a real backup via the admin UI (`AdminBackupPage.tsx`), confirm
   the manifest/checksum, deliberately corrupt data, restore, confirm
   the original data returned - this is the FIRST time the Windows-
   bundled `pg_dump.exe`/`pg_restore.exe` at their real installed path
   would be exercised end to end; nothing in this sandbox could prove
   that specific path before now.
5. Check an offline update package via the admin UI, generate a
   support bundle and manually confirm no secrets appear in it.
6. **Uninstall** via "Programs and Features" (or the Burn bundle's own
   uninstall UI, once built). Confirm the application is removed but
   `%ProgramData%\Hexyrn Core\` (including `postgresql-data\`) is
   NOT touched unless the second, explicit "also delete data" prompt
   was confirmed - test BOTH paths (keep data, delete data), exactly as
   `scripts/uninstall-docker.sh`'s two paths were both tested for the
   Docker deployment this phase.
7. Record real evidence at each step (screenshots, exact command
   output) - this is what turns "PARTIALLY AUTOMATED" into "VERIFIED"
   in `P3-ENVIRONMENT-VERIFICATION.md`.

Only after all of the above genuinely passes, on a genuinely clean
machine, with a genuinely signed artifact, should RC1 be considered for
release-candidate declaration - and that declaration itself is a
business decision for the coordinator/user, not something this
preparation document makes on its own.
