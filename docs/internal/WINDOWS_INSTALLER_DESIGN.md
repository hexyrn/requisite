# Windows Installer Design (P3 item 3)

**Status honestly stated up front:** `installer/windows/Product.wxs` and
`installer/windows/Bundle.wxs` GENUINELY COMPILE, on the real Windows 11
RC build machine, with the pinned WiX 4.0.6 toolchain, using BOTH real,
independently-verified external artifacts - PostgreSQL 17.11-4 (SHA-256
`b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28`) and
Node.js 20.20.2 (SHA-256
`dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`), no
compile-test stand-ins remaining. Real `Product.msi` (88,669,161 bytes)
and Burn bundle `HexyrnCore-1.0.0.0-rc1.exe` (85,528,779 bytes), both
independently inspected via the Windows Installer COM API (22,154 File
rows, 2,348 Components, 2,511 Directories, both
`HexyrnCore`/`HexyrnPostgreSQL` services registered with the exact
designed Arguments/Account). Full exact hashes, the real compiler errors
found and fixed getting here, and the security scan of the staged
payload: see `P3-ENVIRONMENT-VERIFICATION.md`'s "Windows packaging"
section.

**Pre-GA technical debt, recorded explicitly:** Node.js 20 is now out of
upstream maintenance. This RC deliberately does NOT perform a Node
major-version migration as part of Windows packaging - separate
modernization/security work with its own dedicated round and regression
testing, tracked here so it isn't silently forgotten before GA.

**What genuinely remains, stated precisely, not vaguely:** the Burn
bundle's VISUAL uninstall-confirmation checkbox control is not yet
authored (a real, WiX-documented STRING override -
`installer/windows/Bundle.en-us.wxl` - now explains the data-preservation
behavior in the stock uninstall-success text; the underlying
`HEXYRNPURGEDATA` mechanism itself is real and functional via command
line already - see "Uninstall / data retention" below; only the
friendlier interactive checkbox, which needs on-screen visual iteration
this sandbox cannot provide, remains). Code-signing has not been done
(no certificate available - a real, tracked operational gap that gates
DISTRIBUTION but not internal clean-VM functional acceptance, per
explicit instruction). Nothing has been installed, uninstalled, or
upgraded on any machine (deliberately never attempted on this
development machine, to protect its own working PostgreSQL/Node/source
environment - reserved for a clean, snapshotted VirtualBox VM per
`docs/internal/WINDOWS_ACCEPTANCE_PREP.md`).

## Why WiX Toolset - PINNED to 4.0.6, not "latest"

Chosen over NSIS/Inno Setup for one concrete reason: WiX produces a real
`.msi`, which integrates with Windows' own "Programs and Features"
uninstall list, group policy software deployment, and enterprise
patch-management tooling out of the box - relevant for a self-hosted
B2B product where an IT department, not an individual, may be the one
installing/updating it. NSIS/Inno Setup produce a bespoke `.exe`
installer that works fine for a single-user desktop app but doesn't get
the same enterprise-deployment integration for free.

**Version pin, not a detail:** this RC targets WiX Toolset **4.0.6**
specifically, with `WixToolset.Util.wixext` and `WixToolset.Bal.wixext`
also pinned to 4.0.6 - see `.config/dotnet-tools.json` (a committed
local tool manifest, so `dotnet tool restore` reproduces this exact
toolchain on any machine) and `docs/internal/WINDOWS_ACCEPTANCE_PREP.md`'s
install command. This is a real, deliberate decision, not an arbitrary
one: an earlier unpinned `dotnet tool install --global wix` on the real
RC build machine resolved to **WiX 7**, which pulled in an OSMF EULA
acceptance requirement this RC does not want to take on. We returned to
4.0.6 deliberately. Do not "helpfully" upgrade this project to WiX 7
without a separate, explicit decision to accept that EULA.

## Packaging strategy: same build output as Docker, via a real reproducible script

The installer packages the SAME production build output
`apps/api/Dockerfile`'s runtime stage packages - compiled `apps/api/dist`,
production-only `node_modules`, `packages/*/dist`, `apps/web/dist` (see
that Dockerfile's own comments about the npm-workspace-symlink
build-ordering bug found and fixed this phase - the same build process
applies here). Deliberately one build pipeline, two distribution
mechanisms, not a second independently-maintained Windows build that
could drift out of sync with what's actually tested via Docker.

**Reproducibility, concretely, not just as a stated goal:**
`scripts/windows/build-release-payload.ps1` (new this round) is a real,
tested script that does this - `git clone` into a clean workspace
outside OneDrive (see "OneDrive / clean build workspace" in
`docs/internal/WINDOWS_ACCEPTANCE_PREP.md` for why that matters), `npm ci`, build
every workspace in the CORRECT dependency order (`packages/*` before
`apps/*` - a real ordering bug in the root `package.json`'s own `build`
script was found and fixed this round getting this script to work on a
genuinely clean checkout, not just an already-built working tree),
re-run typecheck/lint against that build, `npm ci --omit=dev` to prune
to production-only dependencies, then stage everything into a clean
output directory with an explicit check that no source `.ts` files or
`.env` files leaked into the staged payload. Verified end to end via a
real clean-checkout run - see this round's commit history for the exact
before/after evidence (98.9MB production-only `node_modules`, real
`main.js`/`index.html` present, zero stray source/secret files).

## Node.js runtime packaging

**A customer installation must not depend on Node.js already being
installed globally**, and the Hexyrn Core Windows Service must execute
against a Hexyrn-controlled runtime, not whatever `node.exe` happens to
be on `PATH` (which could be a different, untested Node major version,
or nothing at all).

**Strategy: bundle the official Node.js Windows x64 binary distribution**
(`node-v20.x.x-win-x64.zip` from `https://nodejs.org/dist/` - the
Node.js Foundation's own official release artifacts, MIT-licensed,
genuinely redistributable) alongside the application payload under
`C:\Program Files\Hexyrn Core\runtime\node\`, and register the Hexyrn
Core Windows Service (`Product.wxs`'s `ServiceInstall`) to launch
`runtime\node\node.exe apps\api\dist\main.js` by its FULL PATH, never a
bare `node` that would resolve through `PATH` - matching exactly how
`apps/api/Dockerfile`'s `CMD ["node", "dist/main.js"]` already only ever
resolves within that image's own controlled `node:20-alpine` base, never
some other Node install.

**UPDATE: this external-artifact boundary is now CLOSED, the same way
PostgreSQL's was.** The official Node.js Windows x64 binary zip
(`node-v20.20.2-win-x64.zip`, matching this repository's `engines.node`
and the Docker image's `node:20-alpine` tag exactly - not a floating
"latest v20") was obtained by the coordinator/user, independently
verified (SHA-256
`dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`), and
staged via `scripts/windows/stage-node-artifact.ps1` (the same
fail-closed hash-verification pattern as
`scripts/windows/stage-postgres-artifact.ps1`) into
`build-release.ps1`'s payload - real archive layout confirmed (a single
top-level `node-v20.20.2-win-x64\` directory containing `node.exe`
directly, plus the official `npm.cmd`/`npx.cmd`/`corepack.cmd` shims and
their own bundled `node_modules`). The raw `.zip` itself is never copied
into the installed payload - only the verified, extracted files.

**Licensing:** Node.js itself is MIT-licensed; its bundled dependencies
(V8, libuv, OpenSSL, etc.) carry their own permissive licenses, all
compatible with redistribution - Node.js's own official Windows binary
distribution exists specifically to be redistributed by downstream
projects, this is not a novel or legally uncertain use. Bundle the
official distribution's `LICENSE` file into the installer payload
alongside PostgreSQL's own `COPYRIGHT` file (see the PostgreSQL section
below) for the same reason.

## PostgreSQL bundling strategy - DECIDED (per explicit product direction)

**Decision, per the coordinator's explicit product direction:** the
standard Hexyrn Windows installer WILL provide and configure a supported
PostgreSQL deployment for the customer (Option B below), rather than
requiring an ordinary SME administrator to install and configure
PostgreSQL themselves first. This section was previously an open,
undecided question (see git history for the prior "NOT YET DECIDED"
version) - it is resolved now, with the concrete mechanism below, unless
real Windows-environment implementation work reveals a concrete blocker
(see "Stop conditions" at the end of this section).

### Source / distribution - genuine, official PostgreSQL only

**Source:** the official EDB (EnterpriseDB) Windows x86-64 binaries
distribution for PostgreSQL - the same organisation and build that
produces the installer already present on this development machine at
`C:\Program Files\PostgreSQL\17\bin` (confirmed present and used
throughout this phase's real pg_dump/pg_restore verification work).
EDB publishes a **separate "binaries" zip archive** (distinct from their
installer `.exe`) specifically intended for exactly this use case -
bundling PostgreSQL into another application's own installer without
running EDB's own interactive setup wizard. This is a genuine, official,
supported distribution channel, not an unofficial or repackaged source.

**Explicitly NOT done, and why:** no PostgreSQL binary has been
downloaded in this sandbox, and none will be fetched or embedded without
the user's explicit action, per the standing rule against downloading
files from any source (even an official one) without going through the
proper approval flow. The Windows-environment round that actually builds
this installer is where a real download happens, verified against EDB's
published SHA-256 checksums before being trusted.

**No proprietary fork:** the bundled PostgreSQL is the unmodified,
genuine upstream binary - Hexyrn does not patch, recompile, or fork
PostgreSQL in any way. This satisfies the explicit "no proprietary
database fork" requirement structurally, not by policy alone.

### Supported major version

**PostgreSQL 17** - Hexyrn's officially supported database major version
for Core/Requisite 1.0, matching the version this entire phase's real
pg_dump/pg_restore verification work was proven against (`pg_dump
(PostgreSQL) 17.11`, confirmed exact version string in
`P3-ENVIRONMENT-VERIFICATION.md`). **UPDATE: the previously-flagged
PG17-Windows/PG16-Docker inconsistency this section noted is now
resolved** - `docker-compose.yml`/`docker-compose.prod.yml` were updated
to `postgres:17-alpine` and the production stack was genuinely rebuilt
and re-verified against PostgreSQL 17 (real migrations, real role
privileges, real RLS behaviour, real backup/restore) - see
`P3-ENVIRONMENT-VERIFICATION.md`'s "PostgreSQL 17 alignment" section for
the exact evidence. Windows and Docker now target the same major
version, so backup/restore interoperability between the two deployment
types no longer crosses a major version boundary.

### Installation process (WiX-driven, silent)

1. The Hexyrn installer's WiX Burn bundle (see "Uninstall / data
   retention" below - a Burn bundle is needed regardless, so this reuses
   the same bootstrapper) extracts the bundled PostgreSQL binaries zip to
   `C:\Program Files\Hexyrn Core\postgresql\` (under the application's
   own Program Files directory - the BINARIES only, not the data
   directory - see "Data directory" below for why those are kept
   separate).
2. Runs PostgreSQL's own `initdb.exe` non-interactively to initialize a
   fresh data directory (see below), with `--auth=scram-sha-256` (modern,
   secure default, not PostgreSQL's historically-weaker `md5`) and a
   randomly generated superuser password (see "Credential generation"
   below) supplied via `initdb`'s `--pwfile` flag reading from a
   temporary file the installer creates and deletes immediately after
   (never passed as a plain command-line argument, which would be
   visible in the process list / Windows Event Log process-creation
   audit events - a real, specific reason to use `--pwfile` over
   `--pwprompt`/inline).
3. Registers PostgreSQL as its OWN Windows Service (via `pg_ctl register`
   or an equivalent WiX `ServiceInstall`), separate from Hexyrn Core's
   own service - two services, not one, each independently
   start/stop-able (relevant for maintenance-mode/update scenarios, and
   matches the existing Docker model where postgres and api are already
   separate processes/containers).
4. Runs the SAME role-creation logic `docker/postgres-init/01-app-role.sh`
   encodes, translated to a `.ps1`/`.sql` script run via `psql.exe`
   against the freshly-initialized instance: creates `hexyrn` (schema
   owner, used only for migrations), `hexyrn_app` (`NOSUPERUSER
NOBYPASSRLS`, restricted runtime role), and `hexyrn_backup`
   (`NOSUPERUSER BYPASSRLS`, backup/restore-only role) - genuinely the
   same three-role separation already verified end-to-end in Docker this
   phase, not a different, un-tested Windows-specific role model.
5. Runs Hexyrn Core's own migrations (`npm run migrate:build` equivalent)
   against the new instance before the Hexyrn Core Windows Service is
   set to start.

### Data directory - persistent, separate from the app binaries

`%ProgramData%\Hexyrn Core\postgresql-data\` - NOT under `Program Files`
(which the installer may reinstall/upgrade over) and NOT under the
per-user profile (a Windows Service should not depend on any particular
user being logged in). This is the same reasoning already applied to
`storage/`/`backups/`/`config/` in `Product.wxs`'s existing
`HexyrnDataFolder` design - PostgreSQL's own data directory joins that
same `ProgramData` location as a sibling, not a special case.

### Port strategy

PostgreSQL listens on `127.0.0.1:5432` ONLY (`listen_addresses =
'localhost'` in the generated `postgresql.conf`) - never bound to a
public/LAN-reachable interface, matching `docker-compose.prod.yml`'s own
"Postgres never exposed to the host" design (there, achieved by simply
not publishing the port; here, achieved by binding to loopback only,
since a Windows Service can't rely on Docker's network isolation). If
port 5432 is already in use (a real possibility - a customer might
already run some other PostgreSQL instance), the installer should detect
this and fail with a clear, actionable error rather than silently
picking a different port that nothing else expects (Hexyrn Core's own
`DATABASE_URL`/`MIGRATE_DATABASE_URL`/`BACKUP_DATABASE_URL` config would
need to agree on whatever port was actually used) - a genuine open
implementation detail for the real Windows round, not resolved further
here.

### Role creation

Covered under "Installation process" step 4 above - reuses
`01-app-role.sh`'s exact three-role model (`hexyrn`/`hexyrn_app`/
`hexyrn_backup`), not a Windows-specific variant. **The Hexyrn Core
application runtime connects ONLY as `hexyrn_app`** (`NOSUPERUSER
NOBYPASSRLS`) - genuinely non-superuser, genuinely non-BYPASSRLS, exactly
as required. `hexyrn_backup` remains BYPASSRLS-but-not-superuser, used
only by the backup/restore mechanism, never by the running application -
same separation verified end-to-end in Docker this phase.

### Credential generation / storage

Each of the three roles' passwords is generated using Node's
`crypto.randomBytes(32).toString('base64')` (the exact same mechanism
`apps/api/src/config/production-config-check.ts` already recommends for
`TOTP_MASTER_KEY_CURRENT` - one consistent secure-random-generation
approach across the whole product, not a separate Windows-specific one)
at install time, INSIDE the installer's own custom action - never a
fixed/default password, never something the installer prompts the
operator to type (removing the "customer picks `password123`" risk
class entirely). Generated passwords are written directly into Hexyrn
Core's own config location (`%ProgramData%\Hexyrn Core\config\`,
file-ACL'd to the Hexyrn Core service account and Administrators only -
the same directory `Product.wxs` already creates as
`HexyrnConfigFolder`) as the `DATABASE_URL`/`MIGRATE_DATABASE_URL`/
`BACKUP_DATABASE_URL` connection strings Hexyrn Core's own
`production-config-check.ts` already expects - never written to a WiX
log file, the Windows Event Log, or anywhere else logging could capture
them (WiX custom actions that generate secrets must use `Type="..."`
attributes that suppress logging of their own output/arguments - a
specific implementation detail to get right on the real Windows round,
flagged here so it isn't missed).

### Backup binary paths

`pg_dump.exe`/`pg_restore.exe` ship as part of the same bundled
PostgreSQL binaries zip (EDB's distribution includes the full client
tool set, not just the server) - installed alongside `postgres.exe`
under `C:\Program Files\Hexyrn Core\postgresql\bin\`. Hexyrn Core's own
`PG_DUMP_PATH`/`PG_RESTORE_PATH` environment variables (already
supported by `realPgDump`/`realPgRestore` in `backup.service.ts` -
genuinely proven this phase, not new for Windows) point directly at this
bundled location, so the installer doesn't need the operator's `PATH` to
contain them at all - closing the exact "was it on PATH or not"
ambiguity that this phase's own sandbox investigation into `pg_dump`
availability ran into originally.

### Upgrade implications

An in-place Hexyrn Core Windows update (item 15's update system) must
NEVER re-run `initdb` or otherwise touch the PostgreSQL data directory -
only Hexyrn Core's own application binaries are replaced; PostgreSQL
itself is upgraded (if ever) as a SEPARATE, explicit, opt-in step, never
bundled silently into an ordinary Hexyrn Core version update. A major
PostgreSQL version upgrade (e.g. 17→18 in the future) requires a real
`pg_upgrade` or dump/restore migration - genuinely risky, human-supervised
work that must never be automated into a routine update. `Product.wxs`'s
`MajorUpgrade` element already only concerns itself with the Hexyrn Core
application files, not the PostgreSQL installation - this is naturally
consistent with the existing design, not a new mechanism.

### Uninstall / data-retention behaviour

Mirrors `scripts/uninstall-docker.sh`'s two-step confirmation exactly,
extended to cover the bundled PostgreSQL: uninstalling Hexyrn Core
removes the application's Program Files binaries (including the bundled
PostgreSQL binaries themselves - those are safe to remove, they're just
executables) but does **NOT** touch
`%ProgramData%\Hexyrn Core\postgresql-data\` (the actual customer
database) or `storage/`/`backups/`/`config/` unless the operator
explicitly confirms a SECOND time that they want the data permanently
deleted too - satisfying the explicit "uninstalling Hexyrn must NOT
silently delete the database" requirement structurally (the data
directory is architecturally separate from what an ordinary uninstall
even touches), not merely by a confirmation dialog that could be
clicked through by habit.

### Docker remains fully supported

None of the above changes or removes the existing Docker deployment path
(`docker-compose.prod.yml`, genuinely verified this phase) - it remains
a fully supported "advanced" deployment option for operators who prefer
it, exactly as the explicit requirement states. The Windows installer is
an ADDITIONAL, more turnkey path, not a replacement. An "advanced
external database" installer path (point the Windows installer at an
operator-managed PostgreSQL instance instead of bundling one) is a real,
separate option worth offering alongside the turnkey bundled path -
tracked here as a genuine future enhancement, not designed further in
this document since the DEFAULT/primary path (bundled PostgreSQL) is
what was explicitly directed and is the harder problem to get right
first.

### Existing PostgreSQL installations - safe detection, not silent reuse

**The installer must never assume a `postgres`/`pg_ctl` found on `PATH`,
or a PostgreSQL service already running on port 5432, belongs to
Hexyrn.** A customer machine may already run an unrelated PostgreSQL
instance (their own database for some other application). The design:

- **Hexyrn's managed installation has an unambiguous identity**: the
  Windows Service is specifically named `HexyrnPostgreSQL` (not
  `postgresql-x64-17` or any name EDB's own installer might use), its
  data directory is specifically `%ProgramData%\Hexyrn Core\
postgresql-data\` (not `C:\Program Files\PostgreSQL\17\data`, EDB
  installer's own default), and it listens on a port the installer
  itself picks and records (see "Port strategy" above) rather than
  assuming 5432 is free or belongs to it.
- **Fresh-install detection**: before running `initdb`, the installer
  checks specifically for a Windows Service named `HexyrnPostgreSQL` and
  for the specific data directory above - NOT for "any PostgreSQL
  service" or "anything listening on 5432." If neither exists, this is
  genuinely a fresh install; proceed with `initdb` into a directory
  `scripts/windows/provision-postgres.ps1` already refuses to run
  against if it already exists (see that script's real, tested guard -
  "refusing to initdb over an existing directory").
- **Upgrade detection (a DIFFERENT installed Hexyrn version) is
  SEPARATE from detecting an unrelated PostgreSQL install**: if
  `HexyrnPostgreSQL` already exists as a service with Hexyrn's own data
  directory present, this is an upgrade of Hexyrn's OWN managed
  instance - handled by "Upgrade implications" above (never re-run
  `initdb`, never touch the data directory). If some OTHER PostgreSQL
  service/instance is detected (any name/port that isn't
  `HexyrnPostgreSQL` + the Hexyrn data directory), the installer must
  leave it completely alone - never stop it, never reuse its port
  without checking availability first, never touch its credentials or
  data.
- **Port collision handling**: if the installer's intended port (5432 by
  default) is already bound by something else, `scripts/windows/
provision-postgres.ps1`'s real `postgresql.conf` hardening step (see
  its `-Port` parameter) picks a different, recorded port rather than
  failing outright or - worse - silently trying to connect to whatever
  already owns 5432 as if it were Hexyrn's own database. The exact
  UI/detection flow for surfacing this choice to the operator during
  install is real Windows-round work (a Burn bundle UI decision, same
  category as the uninstall data-retention question) - not finalized
  further in this document.

### Stop conditions - documented, not yet hit, watch for these on the real Windows round

Per the explicit instruction to stop and document rather than improvise
if bundling creates a concrete problem:

- **Licensing:** PostgreSQL is licensed under the PostgreSQL License (a
  permissive, MIT/BSD-style license) - genuinely safe to redistribute
  binaries under, provided the license text/copyright notice is
  included in the Hexyrn Core distribution (a real, small, concrete
  requirement for the real Windows round - add PostgreSQL's own
  `COPYRIGHT` file to the installer's included files - not yet done,
  flagged here so it isn't missed). No blocker identified.
- **Code-signing:** NOT YET VERIFIED whether EDB's binaries-only zip
  distribution's individual `.exe`/`.dll` files are themselves
  Authenticode-signed by EDB, versus only their interactive installer
  `.exe` being signed. If the bundled binaries are unsigned, Windows
  SmartScreen/Defender may flag them more aggressively than a
  conventionally-signed application, and Hexyrn's own installer signing
  certificate does not automatically extend to third-party binaries it
  merely bundles. **This needs to be checked for real on the Windows
  round before finalizing this approach** - if the raw zip binaries are
  unsigned, the mitigations are (a) confirm the checksum against EDB's
  published SHA-256 instead of relying on Authenticode, and/or (b)
  consider using EDB's actual signed installer in silent/unattended mode
  (`postgresql-17.x-windows-x64.exe --mode unattended ...`, which EDB's
  installer explicitly supports) instead of the raw zip, trading a
  slightly larger/less-customizable bundle for genuine Authenticode
  signature verification. Not a blocker yet - a concrete open question
  to resolve on first real Windows implementation, not improvised around
  here.
- **Maintenance burden:** genuinely accepted, not a blocker - Hexyrn
  becomes responsible for tracking PostgreSQL security releases for the
  bundled version and shipping updated bundles, the same ongoing
  commitment already implicitly accepted by shipping `postgres:17-alpine`
  in the Docker path's own `docker-compose.yml`/`docker-compose.prod.yml`
  (an operator running Docker-Compose-provided Postgres already depends
  on Hexyrn's documentation to tell them when to bump that image tag).
  Not a new category of obligation, just a second deployment path
  carrying the same one.

## Windows Service account - DECIDED: per-service virtual accounts

**`Product.wxs` no longer uses `Account="LocalSystem"`** - it now uses
`Account="NT SERVICE\HexyrnCore"`, a Windows **virtual service account**
(per-service SID), with `NT SERVICE\HexyrnPostgreSQL` planned identically
for the bundled PostgreSQL service once its components are added (see
that file's TODO comment). This is the genuine least-privilege mechanism
Windows provides for exactly this case, not a placeholder:

- The Service Control Manager creates the identity automatically the
  first time the service starts (available on every Windows
  version/edition this product targets - Vista/Server 2008 onward, so no
  compatibility concern for Windows 10/11 Home or Server).
- It cannot interactively log on, has no password to generate, store,
  rotate, or leak - closing an entire class of credential-management
  problem a manually-created local/domain service account would create.
- It gets a real, distinct SID (`NT SERVICE\HexyrnCore` and `NT
SERVICE\HexyrnPostgreSQL` are genuinely different identities, not the
  same account with two names) that filesystem/registry ACLs can target
  specifically - e.g. granting `NT SERVICE\HexyrnCore` write access to
  `%ProgramData%\Hexyrn Core\storage\`/`backups\`/`config\` without
  granting the same to the PostgreSQL service identity, and vice versa
  for `postgresql-data\`.
- Matches the same "don't run as more-privileged than necessary"
  reasoning already applied to `hexyrn_app`/`hexyrn_backup`'s restricted
  Postgres roles and `apps/api/Dockerfile`'s non-root container user -
  the Windows service model now carries the identical philosophy, not a
  weaker one just because it's a different OS.

**Filesystem ACLs (real Windows-round implementation step, exact
mechanism decided here, not yet executed since it needs a real install
to run `icacls` against):**

- `%ProgramData%\Hexyrn Core\storage\`, `backups\`, `config\`: `NT
SERVICE\HexyrnCore` gets Modify; `NT SERVICE\HexyrnPostgreSQL` gets no
  access (it has no reason to read the application's own config/storage).
- `%ProgramData%\Hexyrn Core\postgresql-data\`: `NT
SERVICE\HexyrnPostgreSQL` gets Full Control (PostgreSQL's own
  requirement - it must own its data directory); `NT SERVICE\HexyrnCore`
  gets NO direct filesystem access to this directory at all - the
  application only ever talks to PostgreSQL over its loopback TCP
  connection with its own `hexyrn_app`/`hexyrn_backup` role credentials,
  exactly like the Docker deployment where the api container has no
  filesystem access to postgres's data volume either.
- `C:\Program Files\Hexyrn Core\`: read+execute only for both service
  identities (the application/database binaries are not meant to be
  writable by the running services themselves - matches the same
  "Program Files is read-mostly" reasoning `Product.wxs` already states
  for why data lives under ProgramData instead).
- Service-control permissions: only Administrators may
  start/stop/reconfigure either service (the Windows default for a
  service installed by an elevated MSI - not weakened).

## Uninstall / data retention

Mirrors `scripts/uninstall-docker.sh`'s design (see
`docs/internal/OPERATOR_GUIDE.md` §15), not reinvented separately: removing the
application must not silently delete `storage/`, `backups/`,
`config/`, or `postgresql-data/` under `%ProgramData%\Hexyrn Core`
unless the operator explicitly says so a second time.

**This is now real WiX source, not just a stated design**:
`installer/windows/Bundle.wxs` is a genuine WiX Burn bootstrapper
(confirmed well-formed XML, see this round's validation script) wrapping
`Product.msi` specifically BECAUSE a bare MSI cannot show this kind of
confirmation dialog sequence on its own - implementing the correct
architecture per the explicit instruction not to weaken this
requirement for convenience, rather than trying to force a bare MSI to
do something it structurally cannot. What's real: the bundle exists,
references the real MSI output, and is the correct architectural point
for this UI. What's NOT yet written (real Windows-round, visual-
iteration work, not authored blind - see `Bundle.wxs`'s own header
comment): the actual custom dialog XAML/theme presenting the "keep
data / delete data" choice on the uninstall path specifically.

## What's needed to actually close this item

**DONE, genuinely, this round:** the EDB binaries-zip code-signing
status stop condition is now resolved in practice (the coordinator
independently verified the artifact's SHA-256, which is the concrete
mitigation this document's "Stop conditions" section above said would
substitute for Authenticode verification if the raw binaries turned out
to be unsigned); the PostgreSQL/Docker major-version alignment stop
condition was already closed in an earlier round; `Product.wxs` and
`Bundle.wxs` compile cleanly with zero errors/warnings; the real staged
payload is harvested automatically (`generate-payload-harvest.ps1`); the
PostgreSQL-bundling WiX components (second service, data directory) are
real and confirmed present in the compiled MSI via direct database
inspection; `HEXYRNPURGEDATA`'s underlying data-preservation mechanism
is real and functional.

**ALSO DONE, this round:** rebuilt using the official, checksum-verified
Node.js 20.20.2 Windows binary distribution - no compile-test stand-in
remains; the compiled MSI/Bundle now contain the real official runtime
(22,154 File rows total, up from 20,200 with the stand-in). The Burn
bundle's uninstall-success text now explicitly explains the
data-preservation behavior (`installer/windows/Bundle.en-us.wxl`).

**Still remaining, precisely:**

1. The Burn bundle's fully custom, VISUALLY-VERIFIED interactive
   checkbox control (real, visual Windows-round iteration work - the
   underlying mechanism and an explanatory text override both already
   work; only the friendlier interactive control remains).
2. Code-signing (no certificate available yet - a genuine, tracked
   operational gap that gates distribution, not internal functional
   acceptance).
3. Real testing on a clean, snapshotted VirtualBox VM - install,
   first-run, the full application workflow, real backup/restore via
   the bundled `pg_dump.exe`/`pg_restore.exe`, both uninstall paths, and
   upgrade-in-place (see `docs/internal/WINDOWS_ACCEPTANCE_PREP.md` for the exact
   commands/sequence).
