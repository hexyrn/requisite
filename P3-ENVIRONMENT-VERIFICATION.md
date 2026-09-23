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

## Docker deployment

**Implemented:** `docker-compose.yml` (dev/test Postgres, two-role split -
`hexyrn` migration/owner role, `hexyrn_app` restricted runtime role),
`docker/postgres-init/01-app-role.sh` (creates the restricted role on first
container init), `docs/DOCKER_DEPLOYMENT.md` (documents the role model, the
existing-deployment migration path, and why native `docker-entrypoint-initdb.d`
timing matters). `apps/api/src/db/__tests__/db-role-security.integration.spec.ts`
verifies the ROLE PRIVILEGE LOGIC itself (non-superuser, non-BYPASSRLS,
FORCE RLS on every organisation-owned table) against this sandbox's real
Postgres instance.

**Cannot verify here:** no Docker daemon is available in this sandbox.
`docker compose up` has never been run. Specifically unverified:
container build/startup itself; whether `01-app-role.sh` actually executes
correctly inside the real `postgres:16-alpine` entrypoint sequence (it has
only been reviewed, not run); volume persistence across a container
restart; the healthchecks; network exposure between a (not-yet-built)
application container and the database containers; and whether the
running application, once connected as `hexyrn_app` inside the real
container stack, is actually blocked from superuser operations the same
way this sandbox's differently-provisioned Postgres role was proven to be.

**Needed to close:** on a machine with a working Docker daemon:
1. `docker compose up -d postgres postgres_test` - confirm both start healthy and `01-app-role.sh` created `hexyrn_app` correctly (query `pg_roles` inside the container).
2. Build and run the (not-yet-created) application container against `postgres`, confirm it boots using `hexyrn_app` and the app's own boot-time checks pass.
3. Restart the stack, confirm data persists via the named volume.
4. Run the full `db-role-security.integration.spec.ts` suite against the container-provisioned database specifically (not just this sandbox's native Postgres), to close the exact gap that motivated the item 18 fix in the first place.
5. A production-oriented compose file (app + reverse-proxy example + backup volume) is not yet written - see "Not implemented" below.

---

## Windows packaging

**Status: NOT IMPLEMENTED YET** (tracked here because it belongs in the same environment-constrained category, not because code exists to verify). No Windows installer project, service configuration, or packaged layout has been created in this pass. Requires a Windows environment to build and, per the coordinator's explicit instruction, must not be claimed as working until actually built and exercised there - status will be **IMPLEMENTED — WINDOWS ACCEPTANCE TEST PENDING** once the implementation lands, not before.

**Needed to close:** a Windows build environment (real or CI runner) to:
1. Build the installer artifact from the prepared configuration (once written).
2. Install into a clean/isolated Windows environment.
3. Confirm the Windows service starts, the app is reachable, uninstall behaves as documented, and upgrade-in-place works.

---

## Windows CI runner

**Status: IMPLEMENTED — EXECUTION PENDING.** `.github/workflows/release-pipeline.yml`'s `windows-build` job targets a genuine `windows-latest` GitHub-hosted runner, building the project there. It cannot build/test a Windows installer yet because no installer project exists (see below), and this workflow has not been executed by a real GitHub Actions runner from the sandbox this was authored in - the job definition exists, execution is pending.

---

## Windows installer (P3 item 3)

**Status: NOT IMPLEMENTED.** No installer project (WiX/NSIS/Inno Setup or similar), no Windows service configuration, no packaged-layout definition exists yet. This remains the largest genuinely unstarted piece of P3 - it requires either a Windows development environment to author and iterate the installer project, or accepting a first version authored blind and only verified on the eventual real Windows test.

---

## Docker production deployment (P3 item 4)

**Status: PARTIALLY IMPLEMENTED.** The security-critical piece (the `hexyrn`/`hexyrn_app` two-role split, `docker/postgres-init/01-app-role.sh`) is done and documented (`docs/DOCKER_DEPLOYMENT.md`). NOT done: a production-oriented compose file including an application container and a reverse-proxy example (the current `docker-compose.yml` is dev/test Postgres only, no app container). `docker compose up` itself has never been run in this sandbox (no Docker daemon).

---

## Clean-machine acceptance test (P3 item 47, the 24-step sequence)

**Status: PARTIALLY AUTOMATED.** `apps/api/src/__tests__/clean-machine-harness.integration.spec.ts` (added this phase, passing) chains, against a real Nest application and real Postgres, in one reproducible run: bootstrap → organisation/owner → Requisite installed/enabled/licensed with permissions granted → invite a genuinely distinct second user → login as both → create/submit/approve a requisition → generate/issue a PO → record a goods receipt → real backup (manifest/checksums) → deliberately corrupt live data → restore → verify original data returned → verify auth still works → import a licence via the real HTTP endpoint → verify licence state → check a real signed offline update package via the HTTP endpoint → generate a support bundle via HTTP and verify no secrets leak → confirm restored data is reachable via the ordinary API.

**What this does NOT prove, stated in the harness file's own header:** this harness itself still injects a fake dump step and manually reverts the altered row inside a fake `runPgRestore` callback, rather than shelling out to the real binaries - real `pg_dump`/`pg_restore` execution is now separately, genuinely VERIFIED, but via the dedicated `scripts/real-backup-restore-acceptance.ts` script (see the "PostgreSQL client utilities" section above), not via this harness. Still not proven by either: a real downloaded/signature-verified release ARTIFACT (no artifact has been built - Windows/Docker packaging isn't done); Windows installer install/launch/uninstall; `docker compose up`. This is the single most important remaining gap before "RELEASE CANDIDATE READY" could be honestly declared - it requires a real clean Windows (or at minimum genuinely isolated) environment with no pre-existing Hexyrn state, which this sandbox structurally is not (accumulated dev database, dev dependencies, no way to represent "a customer's machine that has never run Hexyrn before").

**Needed to close:** a real or convincingly isolated environment (a fresh VM/container snapshot at minimum, ideally real Windows) to run the full sequence - including the parts the harness above cannot reach - end to end, producing real evidence (screenshots, command output) at each of the 24 steps.

---

## Summary table

| Area | Implemented in this repo | Verifiable in this sandbox | Blocking environment need |
|---|---|---|---|
| Backup/restore mechanism + HTTP admin endpoints | Yes (full) | **Yes - real pg_dump/pg_restore VERIFIED** (`scripts/real-backup-restore-acceptance.ts`, 11/11 checks pass against real PostgreSQL 17.11 binaries + a real superuser-provisioned `hexyrn_backup` BYPASSRLS role) | None (closed) |
| Update system + HTTP admin endpoints | Yes (full) | Yes (real migrations + real health check proven; the pg_dump-dependent auto-backup preflight step now benefits from real pg_dump being verified above, though not re-exercised specifically inside the update flow) | None (closed for the pg_dump dependency itself) |
| Support bundle + HTTP admin endpoints | Yes (full) | Yes (fully) | None |
| Docker DB role split | Yes (full) | Partially (SQL-level logic verified directly against real Postgres, including the real `hexyrn_backup` role now proven to work end-to-end; not yet run inside the container stack itself) | Docker daemon |
| Docker production compose (app + proxy) | Not yet | N/A | Docker daemon (to build/test once written) |
| Windows installer | Not yet | No | Windows development/build environment |
| Windows CI job definition | Yes (job defined) | No (never executed) | GitHub Actions runner access |
| Clean-machine harness (automatable portion) | Yes (full, passing) | Yes | None - this part is genuinely proven |
| Clean-machine 24-step test (full, including binary/OS-level steps) | Partially (harness above covers the automatable subset; real pg_dump/pg_restore now separately verified) | No | Isolated/clean Windows (or equivalent) environment + a built, signed release artifact |

This file will be updated as further P3 work lands or as any of these
verification gaps are closed in a genuine target environment.
