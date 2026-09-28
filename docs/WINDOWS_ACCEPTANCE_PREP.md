# Windows Acceptance Preparation

**Status update: GENUINELY COMPILES.** Both real external artifacts
(PostgreSQL 17.11-4 and Node.js 20.20.2, both independently verified by
SHA-256) were obtained and used for real, on the real Windows 11 RC
build machine. `installer/windows/Product.wxs` + `installer/windows/
Bundle.wxs` compile with the pinned WiX 4.0.6 toolchain into a real,
independently-inspected `Product.msi` and Burn bundle `.exe` - exact
hashes/sizes and the real compiler errors found and fixed getting here:
see `P3-ENVIRONMENT-VERIFICATION.md`'s "Windows packaging" section.
**The clean-machine acceptance test (install/uninstall/upgrade on a real
machine) has NOT been run - deliberately never attempted on this
development machine, reserved for a clean VirtualBox VM per step 5/7
below. RC1 is NOT declared ready; formal status remains P3 RELEASE
ACCEPTANCE PENDING.**

**Confirmed real state of the Windows 11 build/test machine** (walked
through interactively with the user, not this sandbox): Node.js
20.20.2, npm 10.8.2, PostgreSQL 17.11 (native install), WiX Toolset
4.0.6, WixToolset.Bal.wixext 4.0.6, WixToolset.Util.wixext 4.0.6, `npm
ci` succeeds, production build succeeds, typecheck succeeds, lint 0
errors/1 documented warning, backend 68/68 suites/495/495 tests,
frontend 5/5 files/22/22 tests.

## Prerequisites (once, on the Windows build/test machine)

- Windows 10/11 (Home edition is fine for ordinary installation - no
  Hyper-V/Windows Sandbox/domain membership/Server-only functionality is
  required to INSTALL the product; those are only needed for the
  separate clean-machine ACCEPTANCE TEST below, which runs in its own
  VM, not on this build machine) or Windows Server 2019+, with an admin
  account (WiX and service installation both need elevated privileges).
- .NET SDK 6.0+ (`dotnet --version`) - required to install the WiX
  Toolset as a local tool.
- Node.js 20.x and npm (matching this repository's `engines.node`
  constraint in `package.json`).
- Git, to clone/pull this repository.
- PostgreSQL 17 installed natively on THIS build machine (separate from
  what gets bundled into the installer) - needed to run the backend's
  real Postgres integration tests as part of verifying the build itself,
  per step 2 below.
- (For step 5) A separate clean Windows VM - VirtualBox or Hyper-V - NOT
  Windows Sandbox (Windows Sandbox is convenient but resets on every
  close, which makes it awkward for the multi-step, evidence-recording
  acceptance sequence in step 7; a snapshotted VM you can roll back to
  "clean" and re-run is the better fit here, and matches what the
  coordinator/user's own acceptance environment is - VirtualBox).
- A code-signing certificate for the installer artifact itself (a
  real, separate acquisition - not addressed further here; an unsigned
  `.msi`/`.exe` will trigger SmartScreen warnings and is not appropriate
  for a genuine customer-facing RC1 build).
- **The two genuine external artifacts this whole effort needed - both
  now obtained and independently verified, real hashes on record:**
  - PostgreSQL 17.11-4's official EDB Windows x86-64 **binaries**
    distribution (NOT the interactive installer .exe - a separate
    "binaries" zip EDB publishes specifically for bundling into another
    application's own installer), from
    `https://www.enterprisedb.com/download-postgresql-binaries`. SHA-256
    `b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28`.
  - Node.js 20.20.2's official Windows x64 binary zip, from
    `https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip`.
    SHA-256
    `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`.

  Always re-verify against the file you actually have before trusting
  it (`Get-FileHash -Algorithm SHA256` - `scripts/windows/stage-postgres-artifact.ps1`
  and `scripts/windows/stage-node-artifact.ps1` do this automatically
  and fail closed on any mismatch) - never skip this step even though
  these specific hashes are now on record here.

## 1. Install the WiX toolchain - PINNED to 4.0.6, not "latest"

**Do not run an unpinned `dotnet tool install --global wix`** - that is
exactly what previously resolved to WiX 7 on this project's own real
build machine and pulled in an OSMF EULA-acceptance requirement this RC
deliberately avoids. Pin every version explicitly:

```powershell
dotnet new tool-manifest             # once per repo checkout, if not already present
dotnet tool install --local wix --version 4.0.6
dotnet tool run wix -- --version     # confirm: should print 4.0.6, not 7.x
dotnet tool run wix -- extension add WixToolset.Util.wixext/4.0.6
dotnet tool run wix -- extension add WixToolset.Bal.wixext/4.0.6   # needed for the Burn bundle (installer/windows/Bundle.wxs, uninstall data-retention UI)
```

(A local tool manifest, not `--global`, is deliberate too - it pins the
exact version PER REPOSITORY CHECKOUT in `.config/dotnet-tools.json`,
which should be committed, so a future `dotnet tool restore` on any
machine reproduces the exact same 4.0.6 toolchain rather than whatever
happens to be globally installed.)

## 2. Build Hexyrn Core + Requisite RC1

Use the real, tested packaging script (`scripts/windows/build-release-payload.ps1`,
verified this round via an actual clean-checkout build - see its own
doc comment and this repository's commit history) rather than the
manual steps this section used to describe by hand:

```powershell
.\scripts\windows\build-release-payload.ps1 -CleanCheckout -OutDir dist-release\payload
```

This clones a fresh checkout (bypassing OneDrive entirely for the build
itself - see "OneDrive / clean build workspace" below), runs `npm ci`,
builds every workspace in the correct dependency order (`build:packages`
then `apps/api`+`apps/web` - see the real build-ordering bug this round
found and fixed in the root `package.json`), re-runs typecheck and lint
against THIS build, then stages the production-only payload (compiled
`dist/`, production-only `node_modules` via `npm ci --omit=dev` after
building, `packages/*/dist`, `apps/web/dist`) into `dist-release\payload`

- verified to contain zero stray `.ts` source files and zero `.env`
  files.

Separately, run the full test suite (not part of the payload script
itself, since it's slower and the payload script's own typecheck/lint
gate is enough for routine iteration - run this before a REAL release
build specifically):

```powershell
cd apps\api; npx jest --runInBand; cd ..\..
cd apps\web; npx vitest run; cd ..\..
```

`apps\api`'s Jest suite needs a real PostgreSQL 17 instance reachable
via `TEST_DATABASE_URL` (see `.env.example`) on THIS build machine
(separate from whatever gets bundled into the installer for customers -
this is testing the BUILD, not the bundled-Postgres installer's own
provisioning, which step 3 below covers with
`scripts/windows/provision-postgres.ps1`).

### OneDrive / clean build workspace

This repository's own working checkout is under OneDrive, which has
already caused a real `npm ci` EPERM lock (OneDrive's own sync grabbing
a file npm was mid-write to) and separately caused Docker Desktop
file-sync errors on `node_modules\.bin\*` during this phase's own work.
**These are development-workspace annoyances, not customer runtime
behavior** - do not confuse them with anything the shipped product does.
`-CleanCheckout` above exists specifically so a real release build never
depends on OneDrive's sync timing: it `git clone`s into
`$env:TEMP\hexyrn-release-build-<random>` (outside OneDrive) and does
every `npm ci`/build/prune step there. For belt-and-braces on a machine
where OneDrive continues to cause problems even for the clone step
itself, clone manually into a non-OneDrive path first (e.g.
`C:\build\hexyrn`) and run the payload script there without
`-CleanCheckout` (it will build in place, in that already-clean
location).

## 3. Build the Windows installer

**GENUINELY COMPILES - proven, not aspirational.** Both external
artifacts (PostgreSQL 17.11-4 and Node.js 20.20.2, both independently
verified - see step 1's prerequisites) are used for real by the single
documented entry point:

```powershell
.\scripts\windows\build-release.ps1 `
  -PostgresZipPath "<path-to-postgresql-17.11-4-windows-x64-binaries.zip>" `
  -NodeZipPath "<path-to-node-v20.20.2-win-x64.zip>" `
  -CleanCheckout
```

This runs all 13 real steps in one invocation: verifies both artifacts'
SHA-256 (fails closed on any mismatch), builds the application from a
clean checkout, stages the production payload + both runtimes,
validates the staged payload (no dev deps/secrets/source), generates the
real WiX file harvests, compiles `Product.msi`, compiles the Burn
bundle (`HexyrnCore-<version>-<label>.exe`), and reports exact SHA-256
hashes. Confirmed working end to end on the real Windows 11 RC build
machine - see `P3-ENVIRONMENT-VERIFICATION.md`'s "Windows packaging"
section for the exact artifact hashes/sizes and the real compiler
errors found and fixed getting here.

For manual iteration on the WiX sources alone (not a real release
build), the underlying two `wix build` invocations `build-release.ps1`
runs are:

```powershell
dotnet tool run wix -- build installer\windows\Product.wxs `
  dist-release\PayloadFiles.wxs dist-release\NodeRuntimeFiles.wxs dist-release\PostgresRuntimeFiles.wxs `
  -d HexyrnVersion=1.0.0.0 `
  -d PayloadDir=<staged-payload-dir> -d NodeRuntimeDir=<staged-payload-dir>\runtime\node -d PostgresRuntimeDir=<staged-payload-dir>\runtime\postgresql -d RepoRoot=<repo-root> `
  -ext WixToolset.Util.wixext/4.0.6 `
  -out dist-release\Product.msi

dotnet tool run wix -- build installer\windows\Bundle.wxs `
  -d HexyrnVersion=1.0.0.0 `
  -loc installer\windows\Bundle.en-us.wxl `
  -b dist-release `
  -ext WixToolset.Bal.wixext/4.0.6 `
  -out dist-release\HexyrnCore-1.0.0.0-rc1.exe
```

(Two separate `wix build` invocations, both run from the repository
ROOT, never a subdirectory - `dotnet tool run wix` fails to resolve the
`WixToolset.Bal.wixext` extension when invoked from elsewhere, a real
bug found this round; `Bundle.wxs`'s relative `Product.msi` reference is
resolved via `-b dist-release`, not by changing directories.)

## 4. Verify the artifact / signature

The customer-facing artifact is the Burn bundle's `.exe` (it wraps and
launches the `.msi` - a customer never runs `Product.msi` directly), so
that's what gets signed and manifested:

```powershell
# Code-sign the built bundle (requires the real signing certificate):
signtool sign /f <path-to-cert.pfx> /p <cert-password> /fd sha256 /tr http://timestamp.digicert.com /td sha256 dist-release\HexyrnCore-1.0.0.0-rc1.exe
signtool verify /pa dist-release\HexyrnCore-1.0.0.0-rc1.exe

# Generate the release manifest with the REAL production release-signing
# key (never the default test key - see generate-release-manifest.ts's
# own loud warning if --signing-key-pem-file is omitted; this is a
# SEPARATE key domain from TLS/licence signing - see docs/RELEASE_SIGNING.md):
cd apps\api
npx ts-node scripts\generate-release-manifest.ts `
  --artifact ..\dist-release\HexyrnCore-1.0.0.0-rc1.exe `
  --product-id hexyrn-core `
  --version 1.0.0-rc1 `
  --requires-core-version ">=1.0.0-rc1" `
  --artifact-type windows-installer `
  --signing-key-pem-file <path-to-REAL-release-signing-private-key.pem> `
  --signing-key-id <real-key-id> `
  --out ..\dist-release\HexyrnCore-1.0.0.0-rc1.manifest.json
cd ..\..
```

If the real signing certificate/key isn't available yet: this is exactly
the kind of external operational blocker the coordinator's instructions
say to document rather than fake - run the build/harvest/compile steps
above, confirm the unsigned artifact's contents are correct (step below),
and treat code-signing + manifest-signing as a separate, tracked
operational acceptance item, not something to skip past with a fabricated
signature.

## 5. Launch a clean VirtualBox VM

Per the coordinator's own environment: a snapshotted **VirtualBox** VM
with a clean Windows install and no prior Hexyrn/PostgreSQL/Node state,
not Windows Sandbox (Sandbox resets on every close, which is awkward for
this section's multi-step, evidence-recording sequence - a VM you
snapshot BEFORE install and can roll back to repeatedly is the better
fit here). Windows Home is fine as the guest OS - the installer itself
must not require Hyper-V/Server-only features to install (only this
outer acceptance-testing VM needs virtualization, which is a property of
the TEST environment, not a requirement the installer imposes on a real
customer's machine).

1. Create the VM, install a clean supported Windows edition, take NO
   further action inside it yet.
2. **Snapshot immediately** (before step 6 below) - this is what lets
   the acceptance test in step 7 be re-run from genuinely clean state as
   many times as needed, rather than only once.

## 6. Transfer only the release artifact and acceptance harness

Deliberately NOT the whole repository - the point of this step is
proving what a REAL CUSTOMER receives installs and works, not that "the
dev environment can run it":

- `dist-release\HexyrnCore-1.0.0.0-rc1.exe` (the signed Burn bundle)
- `dist-release\HexyrnCore-1.0.0.0-rc1.manifest.json`
- A copy of `docs/OPERATOR_GUIDE.md` (what a real customer would read)
- The acceptance checklist below (this document, or a printed/copied
  version of it)

VirtualBox's Shared Folders (read-only) or simple drag-and-drop (with
Guest Additions installed) both work - use a READ-ONLY share for the
artifact so the guest VM can't accidentally write back into the host's
build output.

## 7. Execute the clean-machine acceptance test

Inside the clean VM, WITHOUT installing Node.js, PostgreSQL, or anything
else the installer itself should be providing (that's exactly what's
being tested - a real SME administrator's machine):

1. Run the signed `HexyrnCore-1.0.0.0-rc1.exe` (the Burn bundle - it
   installs `Product.msi` internally). Confirm: PostgreSQL 17 installs
   (verify the exact version - `postgres --version` from the bundled
   `bin\` directory must report 17.x, never a different major version),
   initializes, and starts as its own Windows Service (`HexyrnPostgreSQL`,
   running as the `NT SERVICE\HexyrnPostgreSQL` virtual account - check
   via Services.msc or `sc.exe qc HexyrnPostgreSQL`); the three Postgres
   roles (`hexyrn`/`hexyrn_app`/`hexyrn_backup`) are created with the
   correct privileges (verify via `psql` from the bundled `bin\`
   directory - `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
WHERE rolname LIKE 'hexyrn%'` should show exactly the same three-row
   result this phase already proved in Docker AND on this Windows
   machine's own isolated test instance - see this phase's commit
   history for that direct verification); migrations run; the Hexyrn
   Core Windows Service (`HexyrnCore`, running as `NT SERVICE\HexyrnCore`)
   starts and is reachable at `https://localhost/` (or whatever port/TLS
   the installer configures); confirm `HexyrnPostgreSQL` genuinely starts
   BEFORE `HexyrnCore` (check service dependency ordering, or just that
   Core doesn't crash-loop on a cold boot where both are set to
   auto-start).
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
machine, with a genuinely signed artifact, should the status change from
**P3 RELEASE ACCEPTANCE PENDING** to **"Hexyrn Core 1.0 + Requisite 1.0
RC1 - ready for first-customer acceptance testing"** - not GA, not "RC1
ready" on its own, and that status change itself is a business decision
for the coordinator/user to make once this evidence exists, not
something this preparation document declares on its own.
