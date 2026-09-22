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

## PostgreSQL client utilities (pg_dump / pg_restore)

**Implemented:** `apps/api/src/platform/backup/backup.service.ts` - full
backup/restore orchestration (manifest, checksums, integrity verification,
retention, compatibility, destructive-restore guard), with the actual
`pg_dump`/`pg_restore` invocation behind an injectable function boundary
(`realPgDump`/`realPgRestore`, shelling out via `child_process.execFile`).
15/15 tests pass using an injected fake dump/restore function against a
real filesystem and real Postgres connection (for the installed-apps
query).

**Cannot verify here:** `pg_dump` and `pg_restore` are not installed in
this sandbox (`which pg_dump` / `which pg_restore` both fail). The real
`child_process.execFile('pg_dump', [...])` code path
(`realPgDump`/`realPgRestore`) has never actually executed. Command
construction is implemented and reviewable, but exit-code handling,
`--format=custom` compatibility with the real binary, timeout behaviour,
and process-termination behaviour under `pg_dump`/`pg_restore` specifically
are unverified.

**Needed to close:** run on a machine/container with real PostgreSQL client
tools installed:
1. `createBackup()` wired to `realPgDump()` against a populated database - confirm a real `.dump` file is produced and is restorable.
2. `restoreBackup()` wired to `realPgRestore()` - confirm it actually replaces database contents.
3. The full destructive cycle from P3 item 13: seed data → backup → alter/delete data → restore → verify original data returned.
4. Exit-code/failure-path testing: `pg_dump` failing (wrong credentials, disk full, killed mid-run) is surfaced as an actionable error, not a silently "successful" partial file.

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

**Status: NOT IMPLEMENTED YET.** No CI pipeline definition exists yet for a Windows-specific build/package/smoke-test job. Per instruction: build the pipeline definition even though it cannot be executed from this sandbox; do not claim it has passed.

---

## Clean-machine acceptance test (P3 item 47, the 24-step sequence)

**Status: NOT AUTOMATED YET beyond what the Playwright E2E from the Requisite UI phase already covers (login → requisition → approval → PO → goods receipt).** The backup/restore, offline-update, support-bundle, and signature-verification steps of the full sequence are not yet wired into a single reproducible script. This is the single most important P3 acceptance test per the original spec and remains the final gate before any "RELEASE CANDIDATE READY" declaration - it requires a real clean Windows (or at minimum a genuinely isolated) environment with no pre-existing Hexyrn state, which this sandbox is not (it has an accumulated dev database, dev dependencies, and no way to represent "a customer's machine that has never run Hexyrn before").

**Needed to close:** a real or convincingly isolated environment (a fresh VM/container snapshot at minimum, ideally real Windows) to run the full sequence end to end and produce real evidence (screenshots, command output) at each of the 24 steps.

---

## Summary table

| Area | Implemented in this repo | Verifiable in this sandbox | Blocking environment need |
|---|---|---|---|
| Backup/restore mechanism | Yes (full) | Partially (everything except real pg_dump/pg_restore exec) | `pg_dump`/`pg_restore` binaries |
| Docker DB role split | Yes (full) | Partially (SQL-level logic only, not the container stack) | Docker daemon |
| Docker production compose (app + proxy) | Not yet | N/A | Docker daemon (to build/test once written) |
| Windows installer | Not yet | No | Windows build environment |
| Windows CI | Not yet | No | Windows CI runner access |
| Clean-machine 24-step test | Not automated | No | Isolated/clean Windows (or equivalent) environment |

This file will be updated as further P3 work lands or as any of these
verification gaps are closed in a genuine target environment.
