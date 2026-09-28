# P0 Deviations from Architecture v1.0

This file records genuine contradictions or problems encountered while
implementing P0. Per the task brief, it is empty of _architectural_
deviations - nothing here required changing Architecture v1.0 itself.

The one significant note is an **environmental limitation** (since
resolved via a workaround), not an architecture deviation, kept here for
transparency about what happened during implementation:

## RESOLVED - Environmental: Docker Desktop was non-functional in this sandbox

**Update: worked around, not a blocker.** A native (non-Docker) PostgreSQL
17 install was used instead - see `docs/decisions/0001-database-layer.md`'s
scope (the choice of `pg`+Kysely is unaffected either way) and
`.env.example`'s note on `TEST_DATABASE_URL` for the equivalent setup. The
connecting role (`hexyrn`) was verified empirically (`rolsuper = false`,
`rolbypassrls = false`) to be a genuine non-superuser, non-RLS-bypassing
role, so `FORCE ROW LEVEL SECURITY` is exercised for real, not silently
bypassed by connection privilege. Every test described as "written but
unexecuted" below was subsequently run for real against this instance -
see the final P0 report for the complete, current pass/fail totals. The
original problem description is kept below for the record.

### Original problem (Docker Desktop)

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

**Consequence at the time:** `docker compose up -d postgres postgres_test`
could not be run in that session, so the integration/security test suites
that require a real Postgres could not be executed there.

**What was done instead of silently skipping this (at the time):**

- All such tests were fully written as real integration tests against
  Kysely/`pg`/Nest - not mocked - ready to run unmodified against any real
  Postgres.
- They were gated with `describe.skip` when `TEST_DATABASE_URL` is unset
  (see each `*.integration.spec.ts` file), so `npm test` still ran cleanly
  and honestly reported what it could and couldn't exercise, rather than
  failing opaquely or (worse) silently passing against nothing.
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
- This was superseded by the native-Postgres workaround above once it
  became available - all of these tests, plus several added afterward, now
  run for real.
