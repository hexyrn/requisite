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

**What this does NOT prove, stated in the harness file's own header:** real `pg_dump`/`pg_restore` execution (the harness injects a fake dump step and manually reverts the altered row inside the fake `runPgRestore` callback, rather than genuinely restoring from binary dump content); a real downloaded/signature-verified release ARTIFACT (no artifact has been built - Windows/Docker packaging isn't done); Windows installer install/launch/uninstall; `docker compose up`. This is the single most important remaining gap before "RELEASE CANDIDATE READY" could be honestly declared - it requires a real clean Windows (or at minimum genuinely isolated) environment with no pre-existing Hexyrn state, which this sandbox structurally is not (accumulated dev database, dev dependencies, no way to represent "a customer's machine that has never run Hexyrn before").

**Needed to close:** a real or convincingly isolated environment (a fresh VM/container snapshot at minimum, ideally real Windows) to run the full sequence - including the parts the harness above cannot reach - end to end, producing real evidence (screenshots, command output) at each of the 24 steps.

---

## Summary table

| Area | Implemented in this repo | Verifiable in this sandbox | Blocking environment need |
|---|---|---|---|
| Backup/restore mechanism + HTTP admin endpoints | Yes (full) | Partially (everything except real pg_dump/pg_restore exec) | `pg_dump`/`pg_restore` binaries |
| Update system + HTTP admin endpoints | Yes (full) | Yes (real migrations + real health check proven; only the pg_dump-dependent auto-backup preflight step is unverified) | `pg_dump` binary (for the auto-backup path only) |
| Support bundle + HTTP admin endpoints | Yes (full) | Yes (fully) | None |
| Docker DB role split | Yes (full) | Partially (SQL-level logic only, not the container stack) | Docker daemon |
| Docker production compose (app + proxy) | Not yet | N/A | Docker daemon (to build/test once written) |
| Windows installer | Not yet | No | Windows development/build environment |
| Windows CI job definition | Yes (job defined) | No (never executed) | GitHub Actions runner access |
| Clean-machine harness (automatable portion) | Yes (full, passing) | Yes | None - this part is genuinely proven |
| Clean-machine 24-step test (full, including binary/OS-level steps) | Partially (harness above covers the automatable subset) | No | Isolated/clean Windows (or equivalent) environment + real pg_dump/pg_restore + a built, signed release artifact |

This file will be updated as further P3 work lands or as any of these
verification gaps are closed in a genuine target environment.
