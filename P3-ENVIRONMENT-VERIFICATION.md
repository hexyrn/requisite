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

## Windows packaging

**Status: IMPLEMENTED — DESIGN/SOURCE ONLY, NOT BUILT.** `installer/windows/Product.wxs` (a real WiX Toolset v4 source file, not a stub) and `docs/WINDOWS_INSTALLER_DESIGN.md` now exist, making every concrete decision an installer needs: packaging the same `apps/api/dist`/`node_modules` build output Docker uses, Program Files + ProgramData directory layout, Windows Service registration via WiX's `ServiceInstall`/`ServiceControl` (`StartType="demand"`, not auto-start, deliberately), and an uninstall design that mirrors `scripts/uninstall-docker.sh`'s two-step data-retention confirmation. **Confirmed no WiX toolchain is available to actually compile this** (`which candle.exe light.exe makensis.exe wix.exe` all failed in this environment).

**UPDATE: the PostgreSQL bundling question is now DECIDED**, per explicit product direction: the Windows installer will provide/configure PostgreSQL for the customer (not require a pre-installed instance). `docs/WINDOWS_INSTALLER_DESIGN.md` documents the full mechanism (genuine official EDB PostgreSQL 17 binaries distribution, `initdb`-then-role-creation matching `01-app-role.sh`'s exact three-role model, data directory under `%ProgramData%`, loopback-only port binding, securely-generated per-install credentials never logged, backup binaries bundled alongside, upgrade/uninstall behavior that never touches customer data without a second explicit confirmation) with two genuinely open, documented "stop conditions" rather than improvised answers: (1) whether EDB's raw binaries-zip distribution is itself Authenticode-signed (not yet verified - would determine whether to use the zip or drive EDB's own signed installer in silent mode instead); (2) a real inconsistency this review surfaced - the Windows path is designed for PostgreSQL 17 while the Docker path currently ships `postgres:16-alpine`, worth aligning in a future round. `Product.wxs` has explicit `TODO` comments marking exactly what real-Windows-round work is needed to add the bundled-PostgreSQL components (a second service registration, the data directory, the role-creation custom action) - not implemented in this sandbox because it would require downloading PostgreSQL binaries, which this environment does not do without explicit user action.

**Needed to close:** a Windows build environment (real or CI runner) to:
1. Resolve the two documented stop conditions above (binaries signing status; version alignment).
2. Install the WiX Toolset v4 and compile `Product.wxs` against a real build output (harvesting the real file list, not hand-enumerating it), adding the bundled-PostgreSQL components per the TODO comments.
3. Add a WiX Burn bundle for the uninstall data-retention confirmation UI a bare MSI can't show on its own.
4. Install into a clean/isolated Windows environment.
5. Confirm both Windows services start, the app is reachable, uninstall behaves as documented (both keep-data and delete-data paths), and upgrade-in-place works.

See `docs/WINDOWS_ACCEPTANCE_PREP.md` for the exact command sequence prepared for this (also not yet executed).

---

## Windows CI runner

**Status: IMPLEMENTED — EXECUTION PENDING.** `.github/workflows/release-pipeline.yml`'s `windows-build` job targets a genuine `windows-latest` GitHub-hosted runner, building the project there. It cannot build/test a Windows installer yet because no installer project exists (see below), and this workflow has not been executed by a real GitHub Actions runner from the sandbox this was authored in - the job definition exists, execution is pending.

---

## Windows installer (P3 item 3) — superseded, see "Windows packaging" above

**UPDATE: no longer "not implemented" in the strict sense** - real WiX
source and a design document now exist (see "Windows packaging" above).
Still, correctly, not a working installer: it has never been compiled or
run, and one real product decision (PostgreSQL bundling) remains
unresolved. This heading is kept only as a pointer for anyone searching
for "item 3."

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
| Windows installer | Design/source only (`installer/windows/Product.wxs`, real WiX v4) - not built. PostgreSQL bundling decision now made (see `docs/WINDOWS_INSTALLER_DESIGN.md`), 2 stop conditions documented (binaries signing status, PG17/PG16 version alignment) | No (no WiX toolchain in this environment) | Windows machine + WiX Toolset v4 (exact commands: `docs/WINDOWS_ACCEPTANCE_PREP.md`) |
| Windows CI job definition | Yes (job defined) | No (never executed) | GitHub Actions runner access |
| Clean-machine harness (automatable portion) | Yes (full, passing, **including real pg_dump/pg_restore when configured** - both modes confirmed passing this round) | Yes | None - this part is genuinely proven |
| Clean-machine 24-step test (full, including binary/OS-level steps) | Partially (harness above covers the automatable subset, now with real pg_dump/pg_restore built in; real Docker deployment separately verified) | No | Isolated/clean Windows environment + a built, signed release artifact |

This file will be updated as further P3 work lands or as any of these
verification gaps are closed in a genuine target environment.
