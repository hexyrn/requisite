# Windows Installer Design (P3 item 3)

**Status honestly stated up front:** this is design groundwork, not a
built or tested installer. `installer/windows/Product.wxs` is a real WiX
Toolset v4 source file that makes every concrete decision an installer
needs, but it has never been compiled (no WiX toolchain - `candle.exe`,
`light.exe`, `wix.exe` - is available in this development environment)
and there is no Windows GUI session available here to click through an
install/uninstall even if an `.msi` existed. Classify this as
**IMPLEMENTED-ENVIRONMENT-VERIFICATION-PENDING** for the design/source,
and **NOT IMPLEMENTED** for an actual working installer. See
`P3-ENVIRONMENT-VERIFICATION.md`'s "Windows installer" section.

## Why WiX Toolset v4

Chosen over NSIS/Inno Setup for one concrete reason: WiX produces a real
`.msi`, which integrates with Windows' own "Programs and Features"
uninstall list, group policy software deployment, and enterprise
patch-management tooling out of the box - relevant for a self-hosted
B2B product where an IT department, not an individual, may be the one
installing/updating it. NSIS/Inno Setup produce a bespoke `.exe`
installer that works fine for a single-user desktop app but doesn't get
the same enterprise-deployment integration for free.

## Packaging strategy: same build output as Docker

The installer packages `apps/api/dist` + `apps/api/node_modules` +
`packages/*/dist` - the exact same production build output
`apps/api/Dockerfile`'s runtime stage packages (see that Dockerfile's own
comments about the npm-workspace-symlink build-ordering bug found and
fixed this phase - the same build process applies here). Deliberately
one build pipeline, two distribution mechanisms, not a second
independently-maintained Windows build that could drift out of sync with
what's actually tested via Docker.

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
an ADDITIONAL, more turnkey path, not a replacement.

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

## Windows Service account

`Product.wxs` currently uses `Account="LocalSystem"` as a conservative
placeholder that is guaranteed to work everywhere. A real release should
use TWO dedicated least-privilege service accounts instead (one for the
Hexyrn Core application service, one for the bundled PostgreSQL service -
matching the same "don't run as more-privileged than necessary"
reasoning already applied to `hexyrn_app`/`hexyrn_backup`'s restricted
Postgres roles, and to `apps/api/Dockerfile`'s non-root container user).
Not finalized here - the right mechanism (a machine-local service
account the installer creates vs. requiring the operator to supply one
via Active Directory in an enterprise deployment) is real Windows-
environment implementation work, not a design question this document
needs to resolve further now that the bundling decision itself is made.

## Uninstall / data retention

Mirrors `scripts/uninstall-docker.sh`'s design (see
`docs/OPERATOR_GUIDE.md` §15), not reinvented separately: removing the
application must not silently delete `storage/`, `backups/`,
`config/`, or (now that PostgreSQL is bundled) `postgresql-data/` under
`%ProgramData%\Hexyrn Core` unless the operator explicitly says so a
second time. A bare WiX `.msi` cannot show that kind of confirmation
dialog sequence on its own - this needs a WiX Burn bundle (a small
bootstrapper EXE wrapping the MSI) with a custom UI sequence asking,
specifically, about the database directory now that bundling is the
decided direction, not a hypothetical "one database or two" question.

## What's needed to actually close this item

1. Resolve the two "Stop conditions" open questions above for real
   (EDB binaries-zip code-signing status; PostgreSQL/Docker major-
   version alignment) before finalizing the exact bundling mechanism.
2. A real Windows machine with the WiX Toolset v4 installed
   (`dotnet tool install --global wix`) to compile `Product.wxs`,
   harvest the real `apps/api/dist`/`node_modules` file list (via `wix
   build`'s directory harvesting, not hand-enumeration), add the
   PostgreSQL-bundling components described above, and iterate until it
   actually installs, starts both services, and uninstalls cleanly.
3. A WiX Burn bundle for the uninstall/data-retention confirmation UI
   described above.
4. Real testing on a clean Windows VM (see
   `docs/WINDOWS_ACCEPTANCE_PREP.md` for the exact commands/sequence).
