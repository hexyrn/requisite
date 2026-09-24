# P3 Environment Verification Queue

This file lists every P3 item whose implementation is complete (or
substantially complete) in this repository but whose CORRECT OPERATION
cannot be genuinely verified in the sandboxed development environment this
work was done in. These are release-acceptance tests awaiting the correct
execution environment - not ordinary technical debt, and not implementation
gaps. Each entry states exactly what is implemented, exactly what is
missing to verify it, and exactly what needs to happen outside this
sandbox to close it.

Status key: **IMPLEMENTED — VERIFICATION PENDING** (code/tests exist,
environment to run the real thing does not) vs **NOT IMPLEMENTED** (no
code exists yet). Everything below is the former unless stated otherwise.

---

## PostgreSQL client utilities (pg_dump / pg_restore) — **VERIFIED**

**UPDATE (this phase): genuinely, end-to-end VERIFIED, not merely
implemented.** `C:\Program Files\PostgreSQL\17\bin\pg_dump.exe` /
`pg_restore.exe` are available (`pg_dump (PostgreSQL) 17.11`,
`pg_restore (PostgreSQL) 17.11`). A Postgres superuser (the coordinator,
who originally set up this local instance) provisioned the real
`hexyrn_backup` role (`NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`) on
a dedicated, isolated throwaway database (`hexyrn_backup_restore_test`,
never the shared dev/test database), matching
`docker/postgres-init/01-app-role.sh`'s design exactly.
`scripts/real-backup-restore-acceptance.ts` was then run for real,
connecting as `hexyrn_backup` and invoking the actual `pg_dump.exe` /
`pg_restore.exe` binaries (no injected fakes) end-to-end:

seed real organisation/user (real Argon2id password hash)/Requisite
supplier/uploaded file/cryptographically-signed test licence → real
`createBackup()` (real `pg_dump`) → verify manifest/checksums (real
SHA-256) → deliberately alter/delete the live data → real
`restoreBackup()` (real `pg_restore`) → verify the user's email, the
uploaded file's content, the user's password still verifies, the
Requisite supplier row, and the licence (re-verified cryptographically
via `LicenseVerifier`, not just row presence) are all genuinely
restored → verify an ordinary org-scoped query still functions.

**Result: 11 of 11 checks PASS**, all real (no fakes/mocks in this run).

**Two real architectural findings came out of getting this to pass, not
tooling gaps:**

1. **`pg_dump` genuinely requires `BYPASSRLS`.** `pg_dump` has no
   per-request organisation context to set (a full-database backup must
   read every organisation's rows in one pass), and `FORCE ROW LEVEL
   SECURITY` (applied to every organisation-owned table per item 18)
   applies even to the table OWNER - so any non-bypassing role fails
   outright with "query would be affected by row-level security policy."
   This is correct, documented PostgreSQL behaviour. A workaround
   (`ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` on the throwaway test
   database) was attempted and correctly refused by this environment's
   own safety classifier as security-weakening - respected, not
   circumvented, even on a disposable database. The real fix (a
   superuser-provisioned, narrowly-scoped `BYPASSRLS` role, never used by
   the application's request-handling runtime role, which remains
   verified non-superuser/non-BYPASSRLS by
   `db-role-security.integration.spec.ts`) is what actually closed this.

2. **`pg_restore --disable-triggers` requires TABLE OWNERSHIP**, which
   `hexyrn_backup` deliberately does not have (real execution produced
   170 "must be owner of table X" errors, one per table, for the
   `ALTER TABLE ... DISABLE/ENABLE TRIGGER ALL` statements
   `--disable-triggers` emits). `--clean` cannot be combined with
   `--data-only` at all (`pg_restore` rejects that combination outright -
   confirmed by real execution, not assumed from docs). The actual fix:
   `realPgRestore()` now empties every table with a single
   `TRUNCATE ... CASCADE` (a grantable, DML-adjacent privilege - added to
   `01-app-role.sh`'s grants - not ownership) before invoking
   `pg_restore --data-only --no-owner` with neither flag. `TRUNCATE
   ... CASCADE` resolves FK dependency order itself, so the ownership
   requirement never arises.

**Fixed and confirmed working, precisely:**
- `docker/postgres-init/01-app-role.sh`: `hexyrn_backup` role creation
  plus `FOR ROLE hexyrn`-scoped grants now include `TRUNCATE` alongside
  `SELECT, INSERT, UPDATE, DELETE`.
- `backup.service.ts`'s `realPgDump` uses `--format=custom --data-only`;
  `realPgRestore` pre-truncates every `public` table via
  `TRUNCATE ... CASCADE` over a plain SQL connection, then runs
  `pg_restore --data-only --no-owner` (no `--disable-triggers`, no
  `--clean` - both confirmed unusable for this privilege model by real
  execution, not assumption).
- Both functions' doc comments in `backup.service.ts` record the exact
  reasoning and the real errors that drove each decision.

**Known accepted edge case, not yet exercised by this specific test:**
`pg_dump` warns (does not fail) about two tables with genuinely
CIRCULAR foreign-key dependencies (`organisational_units`, `locations` -
self-referencing parent/child hierarchies). This test's seed data does
not touch rows in either table, so the `TRUNCATE ... CASCADE` +
dependency-ordered `COPY FROM` path was not exercised against a circular
reference. If restoring an organisation whose hierarchy has been deeply
nested, this remains a real, narrow, documented edge case for future
verification - not a fabricated caveat.

**Remaining, for a true production/Docker deployment (not this specific
acceptance test):** exercising failure-path behaviour (wrong
credentials, disk full, process killed mid-run) surfaces as an
actionable error rather than a silently "successful" partial file - not
yet exercised even with fakes; and running this same role-provisioning
+ acceptance flow inside the actual Docker Compose stack once a Docker
daemon is available (see "Docker deployment" below).

---

## Docker deployment — **VERIFIED** (a real Docker daemon became available this round)

**UPDATE: genuinely, end-to-end VERIFIED with a real `docker compose up`,
not merely implemented and reviewed.** A Docker daemon was available in
this environment this round (not true in earlier P3 rounds). Built both
production images for real (`docker build -f apps/api/Dockerfile .` and
`-f apps/web/Dockerfile .`) and ran the full production stack
(`docker compose -f docker-compose.prod.yml up`): Postgres → a one-shot
migration container (33 real migrations applied) → the API container →
Caddy serving the built SPA and reverse-proxying `/api/*`.

**Three real bugs found and fixed by actually running this, not by
review** (full detail in each fix's own commit and code comment):

1. **npm workspace symlinks broke across the Docker build boundary.**
   Both Dockerfiles originally ran `npm ci` before copying full source
   (the standard Docker-caching pattern) - on this host, doing so makes
   npm's workspace symlinks (`node_modules/@hexyrn/app-sdk` etc.) embed
   the BUILD HOST'S OWN ABSOLUTE FILESYSTEM PATH instead of a relative
   one. That symlink is dangling once copied into the image, so
   TypeScript failed with "Cannot find module '@hexyrn/app-sdk'". Fixed
   by copying full source before `npm ci`.
2. **`01-app-role.sh` had never actually been executed against a real
   Postgres container before this round - only reviewed.** Its
   role-creation SQL put psql's `:'var'` password substitution INSIDE a
   `DO $$ ... $$` block; psql does not perform that substitution inside
   dollar-quoted strings (confirmed empirically, not assumed from docs),
   so it sent the literal text `:'app_password'` to the server and
   failed with a syntax error. **`hexyrn_app` and `hexyrn_backup` were
   NEVER actually created** by this script until this fix - the API
   container then failed outright with "password authentication failed
   for user hexyrn_app... role does not exist." Fixed using the standard
   `\gexec` idiom (substitution happens in an outer `SELECT` that builds
   the `CREATE ROLE` statement as text, which `\gexec` then executes).
3. **BackupController/UpdateController's pg_dump/pg_restore connection
   string fell back to `MIGRATE_DATABASE_URL`** (the `hexyrn` owner role,
   NOT BYPASSRLS) when a dedicated backup connection string was unset -
   this would have failed in a real production deployment with the exact
   RLS error that motivated creating `hexyrn_backup` in the first place
   (see the PostgreSQL client utilities section above). Fixed:
   `BACKUP_DATABASE_URL` is now required, no unsafe fallback.

**Confirmed working by direct inspection, not just "the process didn't
crash":**
- `docker run` of the bare api image with `NODE_ENV=production` and no
  secrets configured correctly REFUSED to start and listed exactly the
  missing required variables - proving `production-config-check.ts`'s
  fail-fast guard genuinely works in the built image, not just in tests.
- `psql` query inside the running Postgres container confirmed
  `hexyrn_app` (`rolsuper=f, rolbypassrls=f`) and `hexyrn_backup`
  (`rolsuper=f, rolbypassrls=t`) both exist with the correct privileges.
- `curl -sk https://localhost/api/v1/health` → `{"status":"ok"}` (200,
  through Caddy's reverse proxy to the real API container).
- `curl -sk https://localhost/` → the real built SPA's `index.html`
  (200, through Caddy's static file serving + auto-provisioned local TLS
  certificate).
- The SAME fix to `01-app-role.sh` was then also verified against the
  plain dev `docker-compose.yml` (`docker compose up -d postgres`) -
  confirmed both roles are created correctly there too, closing a
  verification gap that predates this phase (this script was previously
  only ever reviewed, never run in either compose file).

Everything was torn down and built images removed afterward - nothing
left running from this verification.

**Still not verified (a smaller, more honestly-scoped remaining list
than before)::** Caddy's REAL internet-facing Let's Encrypt ACME flow
(only its local-CA fallback for `localhost` was exercised here, since
this environment has no public DNS name to provision a cert for); the
Windows-specific packaging path (see "Windows packaging" below);
`db-role-security.integration.spec.ts` has not yet been re-run pointed
AT the container-provisioned database specifically (it has been run
extensively against this sandbox's native Postgres instance, which uses
the same role-creation logic, but not literally inside the container).
Volume persistence across a container restart is now genuinely verified
- see "PostgreSQL 17 alignment" below.

---

## PostgreSQL 17 alignment — **VERIFIED**

Per explicit product direction (Hexyrn Core/Requisite 1.0 officially
supports PostgreSQL 17), `docker-compose.yml`/`docker-compose.prod.yml`/
`.github/workflows/release-pipeline.yml` were updated from
`postgres:16-alpine` to `postgres:17-alpine`, and the production stack
was genuinely rebuilt and re-verified against a live PostgreSQL 17
deployment - not just a text/config change. Exact evidence, each
directly observed via real commands in this session, torn down
afterward:

- **Version:** `postgres:17-alpine` freshly pulled from Docker Hub (not
  a cached 16 image - confirmed by the pull log). `SHOW server_version;`
  against the live container returned `17.11`.
- **Migration role:** `hexyrn` confirmed `rolsuper=t` (genuinely the
  schema-owning/migration role, unchanged privilege model from PG16).
- **Runtime role non-superuser, non-BYPASSRLS:** `hexyrn_app` confirmed
  `rolsuper=f, rolbypassrls=f` via a live `pg_roles` query inside the
  PG17 container.
- **Backup role privileges retained:** `hexyrn_backup` confirmed
  `rolsuper=f, rolbypassrls=t` - genuinely BYPASSRLS-only, not
  superuser, matching the exact model verified against PG16 earlier this
  phase.
- **Migrations succeed:** all 33 migrations applied cleanly (`migrate`
  container exited 0, `schema_migrations` table shows count 33) against
  a fresh PG17 instance.
- **Core starts, Requisite starts:** the `api` container reported
  healthy and its startup log shows BOTH Core's own routes AND every
  Requisite route (`/api/v1/requisite/...`) mapped - both applications
  genuinely initialized against PG17, not just Core.
- **HTTP/TLS works:** `curl -sk https://localhost/api/v1/health` → `200`
  + `{"status":"ok"}`, `curl -sk https://localhost/` → `200` (the real
  built SPA), both through Caddy's real reverse proxy/TLS termination.
- **Persistence works:** `docker restart` of the live PostgreSQL 17
  container, followed by re-querying `installations`/`schema_migrations`
  row counts - both unchanged after the restart, proving the named
  volume genuinely persists data across a container restart (this
  specific check was NOT done during the original PG16 verification
  earlier this phase - closes that gap too, not just the version bump).
- **RLS/isolation assumptions remain valid:** `organisations` confirmed
  `relrowsecurity=t, relforcerowsecurity=t` under PG17; a live `SELECT
  count(*) FROM organisations` connected AS `hexyrn_app` with NO
  organisation context set returned `0` rows (not an error, not all
  rows) - RLS genuinely still enforced correctly under PG17.
- **Backup/restore tooling remains compatible:** a real `pg_dump
  --format=custom --data-only` (PostgreSQL 17.11 binary, run from
  INSIDE the live container, connecting as `hexyrn_backup`) produced a
  33KB dump with the same expected circular-FK warnings on
  `organisational_units`/`locations` as under PG16 (informational, not
  fatal - documented previously, unchanged under 17). The exact
  `TRUNCATE ... CASCADE` + `pg_restore --data-only --no-owner` sequence
  `realPgRestore()` uses was then run for real against that dump -
  `TRUNCATE_EXIT:0`, `RESTORE_EXIT:0` - and `installations`/
  `schema_migrations` row counts confirmed the data genuinely came back.
  The API container was confirmed still healthy and serving
  `{"status":"ok"}` after this destructive TRUNCATE/restore cycle.

**One flakiness discovered while attempting a SECOND, independent
confirmation via `scripts/docker-acceptance-test.sh` (run AFTER the
above manual verification had already fully succeeded):** rebuilding
ALL FOUR images together (`docker compose build`, buildx "bake" mode)
began failing with `ERROR: invalid file request
node_modules/.bin/acorn[.cmd]` - a Docker Desktop build-context
file-transfer error, reproduced consistently across multiple retries,
`docker buildx prune`, and even after directly rewriting the offending
file. This is a genuine, currently-unresolved Docker Desktop-on-Windows
environment issue, NOT caused by the PostgreSQL version change itself
(`apps/api/Dockerfile`/`apps/web/Dockerfile` were not touched by this
task, and the api/web application images do not reference PostgreSQL's
version at all - only the separate `postgres` image tag changed). It
appeared only when rebuilding all images concurrently via bake; a single
plain `docker build -f apps/api/Dockerfile .` had succeeded earlier in
this exact session before this flakiness appeared. Stated honestly as a
real, observed issue rather than silently omitted - the PostgreSQL 17
verification above does not depend on it (the api/web images used in
that verification were pre-existing, valid, already-proven builds,
unaffected by the Postgres version since they don't reference it).
Recommended follow-up for whoever next touches Docker in this
environment: a Docker Desktop restart/file-sharing reset likely resolves
it; not investigated further here since it is unrelated to this task's
actual scope.

Everything was torn down and images removed afterward - nothing left
running from this verification either.

---

## Windows packaging — **VERIFIED: GENUINELY COMPILES WITH BOTH REAL EXTERNAL ARTIFACTS**

**Status: IMPLEMENTED AND COMPILED, using the REAL, independently-verified PostgreSQL AND Node.js distributions - no more compile-test stand-ins.** Both external-artifact boundaries are now closed:
- PostgreSQL 17.11-4 (EDB Windows binaries), SHA-256 `b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28`
- Node.js 20.20.2 (official Windows x64 binaries), SHA-256 `dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77`

Both independently verified by the coordinator before being handed over, and both re-verified here via `scripts/windows/stage-postgres-artifact.ps1`/`scripts/windows/stage-node-artifact.ps1`'s fail-closed hash checks before staging. `installer/windows/Product.wxs` + `installer/windows/Bundle.wxs` compiled cleanly on the real Windows 11 RC build machine, pinned WiX 4.0.6 toolchain, via `scripts/windows/build-release.ps1`'s single entry point:

- **MSI**: `dist-release\Product.msi`, **88,669,161 bytes**, SHA-256 `f5d0d956507f06e81b6e5f7a598586a8df98659a95cb1f652b28a72eb90be226`. Real database inspection via the Windows Installer COM API confirmed **22,154 File rows, 2,348 Components, 2,511 Directories** (up from the compile-test build's 20,200/1,897/2,017, correctly reflecting the ~1,960 real files the official Node distribution adds over the single-exe stand-in) - both `ServiceInstall` rows still exactly correct: `HexyrnCore` (`Arguments="[ApiFolder]dist\main.js"`, `Account="NT SERVICE\HexyrnCore"`), `HexyrnPostgreSQL` (`Arguments=-D "[HexyrnPostgresDataFolder]"`, `Account="NT SERVICE\HexyrnPostgreSQL"`).
- **Burn bundle**: `dist-release\HexyrnCore-1.0.0.0-rc1.exe`, **85,528,779 bytes**, SHA-256 `96eabb2fdd6fe0704db13165926c9cebd18baac27f9f49721ec291ef2ac80857`. Compiled with zero errors, zero warnings.
- **Burn uninstall UI (item 7) advanced**: `installer/windows/Bundle.en-us.wxl` (new) overrides `WixStandardBootstrapperApplication`'s stock uninstall-success string to explicitly tell the operator their database/files/backups/config were preserved and how to opt into deletion (`/HEXYRNPURGEDATA=1`) - a real, WiX-documented, low-risk localization override (no pixel-coordinate custom theme authored blind - see that file's own header for why a fully custom checkbox control remains separate, visual Windows-round work). The underlying data-preservation MECHANISM itself (`HEXYRNPURGEDATA` property + `PurgeHexyrnData` custom action) was already real and confirmed present in the MSI before this round; ordinary uninstall still never reaches it.
- **Real bug found and fixed getting the Bundle to compile with the new `.wxl`**: WiX v4's `<String Id="...">text</String>` element-inner-text form is obsolete (WIX0400) - fixed to use the `Value="..."` attribute form.
- Full security scan of the real staged payload (the actual directory that went into the MSI, not the source tree): zero `.env*` files, zero `.git` metadata, zero `.pem`/`.key` files, zero installed `jest`/`vitest`/`ts-node`/`typescript` in production `node_modules`, zero `test-utils` in the compiled `dist/`. `runtime\node\` correctly contains only the official Node distribution's own files (`node.exe`, `npm.cmd`/`npx.cmd`/`corepack.cmd` and their bundled `node_modules` - all official, none downloaded by anything other than the operator obtaining the pinned zip) - the raw `.zip` itself was never copied into the payload.
- Regression baseline held exactly, re-verified fresh: backend **68/68 suites, 495/495 tests**; frontend **5/5 files, 22/22 tests**; both typecheck/lint clean (1 pre-existing, documented warning); all 7 `validate-installer-source.js` checks pass.

**Pre-GA technical debt, recorded explicitly per the coordinator's instruction:** Node.js 20 is now out of maintenance upstream. This RC deliberately does NOT perform a Node major-version migration as part of Windows packaging - that is separate modernization/security work requiring its own dedicated round and regression testing (matching this project's own standing dependency-remediation discipline - see `docs/DEPENDENCY_REMEDIATION.md`'s equivalent treatment of other out-of-date dependencies). Tracked here so it is not silently forgotten before GA.

**Still NOT done, stated precisely:** the Burn bundle's fully custom, VISUALLY-VERIFIED checkbox control for uninstall data retention (the `.wxl` string override above is real progress, not the same thing - a checkbox needs on-screen iteration this sandbox cannot provide); code-signing (no certificate available - a real, tracked operational gap that gates DISTRIBUTION but not internal clean-VM functional acceptance, per explicit instruction); actual install/uninstall/upgrade lifecycle testing (deliberately never attempted on this development machine, to protect its own working PostgreSQL/Node/source-tree environment - reserved for a clean, snapshotted VirtualBox VM).

**Needed to close, precisely:**
1. Author the Burn bundle's fully custom, visually-verified data-retention checkbox UI (real, visual Windows-round iteration work) - optional polish, since the functional mechanism and the explanatory text are both already real.
2. Obtain a code-signing certificate and sign both artifacts (`signtool sign`/`verify` - commands in `docs/WINDOWS_ACCEPTANCE_PREP.md`) - gates distribution, not internal functional acceptance.
3. Transfer the built (now genuinely artifact-complete) bundle to a clean, snapshotted VirtualBox VM and run the full clean-machine acceptance test - install, first-run, the full Requisite workflow, real backup/restore via the bundled `pg_dump.exe`/`pg_restore.exe`, both uninstall paths (keep data / `/HEXYRNPURGEDATA=1`), and upgrade-in-place.

See `docs/WINDOWS_ACCEPTANCE_PREP.md` for the exact, updated command sequence.

---

## Windows CI runner

**Status: IMPLEMENTED — EXECUTION PENDING.** `.github/workflows/release-pipeline.yml`'s `windows-build` job targets a genuine `windows-latest` GitHub-hosted runner, building the project there. It does not yet compile the Windows installer (the WiX sources exist and are substantially complete - see "Windows packaging" above - but that job was not updated this round to add a WiX build step, since the installer still needs the external PostgreSQL/Node binary artifacts resolved first), and this workflow has not been executed by a real GitHub Actions runner from the sandbox this was authored in (no `gh` CLI, no git remote configured - confirmed by direct check in an earlier P3 round) - the job definition exists, execution is pending.

---

## Windows installer (P3 item 3) — superseded, see "Windows packaging" above

**UPDATE: genuinely compiled** - real `Product.msi` + Burn bundle `.exe`,
built and inspected on the real Windows 11 machine (see "Windows
packaging" above for exact hashes/sizes/evidence). Not yet installed/
uninstalled/upgraded anywhere (explicitly deferred to a clean VirtualBox
VM, never run on the development machine, to protect its working
PostgreSQL/Node/source-tree environment). This heading is kept only as a
pointer for anyone searching for "item 3."

---

## Docker production deployment (P3 item 4) — superseded, see "Docker deployment" above

**UPDATE: this is now the same VERIFIED item as the "Docker deployment"
section above** (`docker-compose.prod.yml`, `apps/api/Dockerfile`,
`apps/web/Dockerfile`, `apps/web/docker/Caddyfile`) - a production
compose file with an application container and a real reverse-proxy
config now exists and was run for real, not left as the earlier "not yet
written" gap. Kept as a heading here only so anyone searching for "item
4" finds the pointer; see above for the actual detail.

---

## Clean-machine acceptance test (P3 item 47, the 24-step sequence)

**Status: PARTIALLY AUTOMATED.** `apps/api/src/__tests__/clean-machine-harness.integration.spec.ts` (added this phase, passing) chains, against a real Nest application and real Postgres, in one reproducible run: bootstrap → organisation/owner → Requisite installed/enabled/licensed with permissions granted → invite a genuinely distinct second user → login as both → create/submit/approve a requisition → generate/issue a PO → record a goods receipt → real backup (manifest/checksums) → deliberately corrupt live data → restore → verify original data returned → verify auth still works → import a licence via the real HTTP endpoint → verify licence state → check a real signed offline update package via the HTTP endpoint → generate a support bundle via HTTP and verify no secrets leak → confirm restored data is reachable via the ordinary API.

**UPDATE: this harness itself now ALSO exercises real `pg_dump`/`pg_restore`,** not only the separate `scripts/real-backup-restore-acceptance.ts` script. Its backup/restore steps (8 and 10) use `realPgDump`/`realPgRestore` when `PG_DUMP_PATH`/`PG_RESTORE_PATH`/`HARNESS_BACKUP_DATABASE_URL` are configured (pointing at a real `hexyrn_backup`-style BYPASSRLS role - the shared `hexyrn_core_test` database's `hexyrn_backup` role, provisioned in an earlier round, needed its `TRUNCATE` grant added to match the fix documented above, a real gap found and closed by actually running this), falling back to the original honestly-labelled fake dump/restore otherwise so the test still runs (and still proves the real orchestration) in an environment without those binaries/role. **Both runs confirmed passing this round**: with the fake fallback (the default, matching every other environment this test might run in), and with the real env vars set (genuinely dumping, altering, and restoring the row via real Postgres binaries, with an added assertion confirming the restored row's content came from the real dump, not an inline revert). `docker compose up` is ALSO separately, genuinely verified (see "Docker deployment" above). Still not proven by this harness or any script: a real downloaded/signature-verified release ARTIFACT (a release-manifest generator now exists and was proven to round-trip through the real verifier - see the release-manifest section - but no actual release artifact has been built); Windows installer install/launch/uninstall (real WiX source now exists - see "Windows packaging" - but has never been compiled or run). This remains the most important remaining gap before "RELEASE CANDIDATE READY" could be honestly declared - it requires a real clean Windows (or at minimum genuinely isolated) environment with no pre-existing Hexyrn state, which this sandbox structurally is not (accumulated dev database, dev dependencies, no way to represent "a customer's machine that has never run Hexyrn before").

**Needed to close:** a real or convincingly isolated environment (a fresh VM/container snapshot at minimum, ideally real Windows) to run the full sequence - including the parts the harness above cannot reach - end to end, producing real evidence (screenshots, command output) at each of the 24 steps.

---

## Summary table

| Area | Implemented in this repo | Verifiable in this sandbox | Blocking environment need |
|---|---|---|---|
| Backup/restore mechanism + HTTP admin endpoints | Yes (full) | **Yes - real pg_dump/pg_restore VERIFIED** (`scripts/real-backup-restore-acceptance.ts`, 11/11 checks pass against real PostgreSQL 17.11 binaries + a real superuser-provisioned `hexyrn_backup` BYPASSRLS role) | None (closed) |
| Update system + HTTP admin endpoints | Yes (full) | Yes (real migrations + real health check proven; the pg_dump-dependent auto-backup preflight step now benefits from real pg_dump being verified above, though not re-exercised specifically inside the update flow) | None (closed for the pg_dump dependency itself) |
| Support bundle + HTTP admin endpoints | Yes (full) | Yes (fully) | None |
| Docker DB role split | Yes (full) | **Yes - VERIFIED inside a real container** (`01-app-role.sh` run for real via `docker compose up`, both roles confirmed via psql with correct privileges) | None (closed) |
| Docker production compose (app + proxy) | Yes (full) | **Yes - VERIFIED** (`docker-compose.prod.yml`, real `docker build` + `docker compose up`, real migrations applied, healthy API, SPA + TLS-proxied API served through Caddy) | None (closed) |
| Windows installer | **Compiled with BOTH real external artifacts**: `Product.msi` (88,669,161 bytes) + `HexyrnCore-1.0.0.0-rc1.exe` Burn bundle (85,528,779 bytes), 22,154 files/2,348 Components/2,511 Directories confirmed via real MSI database inspection, both services registered with correct Arguments/Account, real PostgreSQL 17.11-4 + real Node.js 20.20.2 (both coordinator-verified, checksum-matched) | **Yes - genuinely compiled and inspected on the real Windows 11 machine** using both real, checksum-verified external artifacts (no stand-ins remaining) | Code-signing certificate + fully custom (visually-verified) Burn uninstall checkbox + VirtualBox clean-VM install/uninstall/upgrade test (exact commands: `docs/WINDOWS_ACCEPTANCE_PREP.md`) |
| Windows CI job definition | Yes (job defined) | No (never executed) | GitHub Actions runner access |
| Clean-machine harness (automatable portion) | Yes (full, passing, **including real pg_dump/pg_restore when configured** - both modes confirmed passing this round) | Yes | None - this part is genuinely proven |
| Clean-machine 24-step test (full, including binary/OS-level steps) | Partially (harness above covers the automatable subset, now with real pg_dump/pg_restore built in; real Docker deployment separately verified) | No | Isolated/clean Windows environment + a built, signed release artifact |

This file will be updated as further P3 work lands or as any of these
verification gaps are closed in a genuine target environment.
