# P0 Deviations from Architecture v1.0

This file records genuine contradictions or problems encountered while
implementing P0. Per the task brief, it is empty of *architectural*
deviations - nothing here required changing Architecture v1.0 itself.

The one significant note is an **environmental limitation**, not an
architecture deviation, recorded here for transparency since it affects
which tests could actually be executed in this session:

## Environmental: Docker Desktop is non-functional in this sandbox

Docker Desktop (v4.91.0) is installed and its CLI works, but the backend
process crashes on every launch attempt (including after a full `wsl
--shutdown` + process kill + relaunch cycle) with:

```
starting services: initializing Ingest server: listening on
unix://C:/Users/Bradl/AppData/Local/Docker/run/sailor-ingest.sock:
rename sailor-ingest.sock sailor-ingest.sock.stale: The file cannot be
accessed by the system.
```

`sailor-ingest.sock` is a Windows reparse-point file (Docker's Unix-socket
emulation). Direct `Remove-Item -Force` on that single file also fails with
"The file cannot be accessed by the system" - this is a sandbox-level
restriction on reparse-point filesystem operations in
`C:\Users\Bradl\AppData\Local\Docker\run`, not a Docker configuration issue,
and not something fixable by restarting processes or the WSL distro (both
were tried).

**Consequence:** `docker compose up -d postgres postgres_test` cannot be
run in this session, so the integration/security test suites that require a
real Postgres (the §8.2 RLS matrix, bootstrap-token-reuse, session/account-
deactivation, password-reset/invitation token tests, and the Nest app boot
test) could not be executed here.

**What was done instead of silently skipping this:**
- All of the above tests are fully written as real integration tests
  against Kysely/`pg`/Nest - not mocked - and are ready to run unmodified
  via `docker compose up -d postgres_test && npm test --workspace apps/api`
  in an environment where Docker works.
- They are gated with `describe.skip` when `TEST_DATABASE_URL` is unset
  (see each `*.integration.spec.ts` file), so `npm test` still runs
  cleanly and honestly reports what it could and couldn't exercise, rather
  than failing opaquely or (worse) silently passing against nothing.
- A fallback via `@electric-sql/pglite` + `@electric-sql/pglite-socket`
  (a real Postgres compiled to WASM, exposed over the wire protocol) was
  attempted as a Docker-free way to get a real Postgres for these tests.
  It was abandoned after confirming `pglite-socket` does not implement
  Postgres role/password authentication (any client is accepted as an
  implicit superuser), which makes it unsuitable for RLS testing
  specifically - RLS's `FORCE ROW LEVEL SECURITY` is bypassed by
  superusers, so tests run against it would give a false pass. Using a
  tool that structurally cannot prove the property under test was judged
  worse than clearly reporting the gap.
- The pure-logic parts of the same subsystems (PermissionEvaluator,
  structured logging/redaction, TOTP generation/verification, Argon2id
  hashing, secure token generation/hashing) do not require a database and
  were run for real - 19 passing tests, see the final P0 report.
