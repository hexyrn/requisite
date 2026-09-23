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

**UPDATE (this phase): the binaries ARE available in this environment.**
`C:\Program Files\PostgreSQL\17\bin\pg_dump.exe` / `pg_restore.exe` exist
and run (`pg_dump (PostgreSQL) 17.11`, `pg_restore (PostgreSQL) 17.11`) -
the earlier "not installed" framing was wrong; they were simply not on
`PATH`. `scripts/real-backup-restore-acceptance.ts` was written to use
them for real, against a dedicated, isolated throwaway database (never
the shared dev/test database), seeding real organisation/user/file data
and attempting a genuine `createBackup()` → alter data → `restoreBackup()`
cycle with the actual binaries.

**A real, important architectural finding came out of that attempt, not
a tooling gap:** `pg_dump` failed with `ERROR: query would be affected by
row-level security policy for table "organisations"`. This is correct,
documented PostgreSQL behaviour, not a bug: `pg_dump` has no per-request
organisation context to set (a full-database backup must read every
organisation's rows in one pass), and `FORCE ROW LEVEL SECURITY` (which
this codebase correctly applies to every organisation-owned table, per
item 18) applies even to the table OWNER - so a dump/restore role that
is not exempted from RLS cannot read OR write organisation-scoped tables
at all, regardless of who owns them. **A full-database backup role
genuinely needs `BYPASSRLS`** - this is the correct, standard use of that
attribute, applied to a narrowly-scoped role used only by the backup/
restore child process, never by the application's request-handling
runtime role (which remains verified non-superuser/non-BYPASSRLS by
`db-role-security.integration.spec.ts`, unaffected by this).

**Fixed as far as this sandbox allows:**
- `docker/postgres-init/01-app-role.sh` now also creates `hexyrn_backup`
  (`NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`, full DML grants,
  `FOR ROLE hexyrn` default-privilege scoping so it actually covers
  migration-created tables - a related, separate bug in the original
  `hexyrn_app` grants found and fixed at the same time).
- `backup.service.ts`'s `realPgDump`/`realPgRestore` switched to
  `--data-only`/`--disable-triggers` - deliberate, not incidental: a
  schema+data dump would additionally require the connecting role to
  OWN every table (for `pg_restore --clean`'s DROP/CREATE) on top of
  BYPASSRLS, a materially larger privilege than backup/restore needs.
  Restoring now correctly assumes the target database's schema was
  already brought up to date via the ordinary migration runner first
  (a genuine prerequisite, documented in `docs/OPERATOR_GUIDE.md` §6),
  and only round-trips row DATA - confirmed by re-running the real
  acceptance script, which got past the schema/ownership concern
  entirely and failed on ONLY the RLS/BYPASSRLS issue above.

**Still cannot fully verify here, and why - stated precisely, not
vaguely:** provisioning `hexyrn_backup` requires `CREATE ROLE`, which
requires PostgreSQL superuser privileges. The `hexyrn` role in this
sandbox's local Postgres instance does not have `CREATEROLE`, and no
superuser (`postgres`) credentials are available here (no `.pgpass`, no
known password, psql prompts interactively with no way to answer it).
**A workaround was deliberately NOT taken**: temporarily running
`ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` on the throwaway isolated
test database (which `hexyrn`, as table owner, technically could do) was
attempted and correctly refused by this environment's own safety
classifier as a security-weakening action - respected, not circumvented,
even though the target was a disposable test database. This is the right
outcome: the fix that matters is the real one (a superuser-provisioned
`BYPASSRLS` role), not a shortcut that happens to produce a green
checkmark.

**Needed to close, precisely:**
1. On a machine/container where a Postgres superuser (or `CREATEROLE`) IS available - run `docker/postgres-init/01-app-role.sh`'s SQL (or the equivalent manual `CREATE ROLE hexyrn_backup ... BYPASSRLS` for a non-Docker deployment) to actually provision the role.
2. Point `PG_DUMP_PATH`/`PG_RESTORE_PATH`/the backup connection string at that role and re-run `scripts/real-backup-restore-acceptance.ts` (already written and ready) - expected to pass now that the RLS blocker's actual cause and fix are known and applied.
3. Confirm exit-code/failure-path behaviour (wrong credentials, disk full, killed mid-run) surfaces as an actionable error, not a silently "successful" partial file - not yet exercised even with fakes.

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
