# ADR 0003: `withOrgContext` connection/transaction guarantees

## Status

Accepted (P0). Written after, and only after, each claim below was verified

- either empirically against real Postgres, or by direct code inspection of
  every call site in the codebase. Two of the guarantees below required a
  code fix before they held; those fixes are described inline, not glossed
  over.

## Purpose

Architecture §8 requires `withOrgContext(organisationId, fn)` to be "the
only place [organisation-scoped RLS context] could be gotten wrong rather
than one per query." This ADR states precisely what that wrapper
(`apps/api/src/db/org-context.ts`) guarantees, and how each guarantee was
verified - not asserted.

## Guarantees

### 1. Pins exactly one physical connection for the whole transaction

`withOrgContext` calls `pool.connect()` exactly once, holds that single
`PoolClient` for `BEGIN` → `set_config(...)` → the caller's callback →
`COMMIT`/`ROLLBACK`, and only releases it once, in a `finally` block.

**Verified**: `db/__tests__/rls-matrix.integration.spec.ts`, test 1 ("§8
baseline: never leaks organisation context across a pooled connection
reused for a different org") forces the pool to `max: 1`, so a second
`withOrgContext` call can only proceed if the first one's connection was
actually returned to the pool - and asserts the second call sees a clean
slate. This is the strongest empirical proof available: if two calls didn't
each get sole use of the one physical connection, the test would deadlock
or leak context, and it does neither.

**A real bug was found and fixed while verifying this.** The original
implementation handed Kysely the raw pinned `PoolClient`. Kysely's
`PostgresDriver` calls `connection.release()` after every top-level query
that isn't inside its own `db.transaction()` block - so on the SECOND query
issued inside `withOrgContext`'s callback, Kysely already believed the
connection had been released, and our own later, deliberate release
double-released it (`pg-pool` threw "Release called on client which has
already been released to the pool"). Fixed by giving Kysely a `Proxy`
around the client that forwards everything except `release()` (a no-op);
only `withOrgContext`'s own `finally` block, holding the real, unproxied
`client` reference, ever calls the real release. See
`singleConnectionPool()` in `org-context.ts` for the full explanation
in-line.

### 2. Every query inside the callback uses that same connection

The `db: Kysely<Database>` handle passed into the callback is constructed
with `new PostgresDialect({ pool: singleConnectionPool(client) })`, where
`singleConnectionPool(client).connect()` always returns the same pinned
client (via the release-swallowing proxy above) - there is no path by which
a query issued through that `db` handle reaches a different connection.

### 3. Application code cannot fall back to the global pool mid-operation

Verified by code inspection, not just design intent: grepping the entire
`apps/api/src` tree (excluding tests and the migration runner) for anything
that constructs its own `Kysely`/`Pool`/calls `getPool()` directly finds
exactly four files, and each is legitimate:

- `db/org-context.ts`, `db/pool.ts` - the abstraction itself.
- `bootstrap/installation.service.ts`, `bootstrap/installation.repository.ts`
  - touch only `installations`/`bootstrap_tokens`, which Architecture §7
    explicitly states are "not itself organisation-owned data" and which
    carry no RLS policy (see migration `0001_installations.sql`'s header
    comment). These two files' shared-pool `db.destroy()` calls were
    themselves a real bug found during testing (see item 3 in the "real bugs
    found" list in the P0 report) - fixed by removing the destroy call, since
    the pool they're given is caller-owned, not theirs to end.

Every other service/controller in the codebase receives `db:
Kysely<Database>` purely as a function parameter, sourced from a
`withOrgContext` callback - there is no service that imports `getPool()` or
constructs its own connection to reach an organisation-owned table.

### 4. Nested service calls preserve context

Because `db` is an ordinary function parameter threaded through call chains
(e.g. `AuthController` → `AuthService.login(db, ...)` →
`SessionService.createSession(db, ...)` → `AuditService.record(db, ...)`),
there is nothing to "preserve" beyond passing the same reference - there is
no ambient/thread-local context to lose. **Verified**:
`rls-matrix.integration.spec.ts` test 6 calls a two-layer nested service
function and asserts `current_setting('app.current_organisation_id', true)`
inside the innermost call still matches the outer `withOrgContext` call's
organisation id.

### 5. Background jobs / scheduled jobs / event consumers / webhooks / async import-export

**N/A - not implemented in P0.** None of these execution contexts exist yet
(no job queue, no event bus/outbox, no webhook framework - all explicitly
P1+ per the task brief's exclusion list). There is therefore nothing to
verify a guarantee about today. What CAN be stated: `withOrgContext`'s
signature (`organisationId: string` required, no optional/omittable
overload) and its complete independence from any HTTP-request-scoped state
(it takes a plain string, not a NestJS request object) mean that whenever
one of these subsystems is built, calling it with an explicit
`job.organisationId`/`event.organisationId` works identically to how a
controller calls it today - nothing about the wrapper itself needs to
change. This is a structural property of the design, not a guess: the
wrapper has zero dependency on `@nestjs/common`'s request-scoping,
`ExecutionContext`, or any other HTTP-specific type.

### 6. Rollback/release is deterministic

Every exit path - success, a thrown business exception, an unexpected
exception, and a dropped connection mid-transaction - goes through the same
`try/catch/finally` structure and ends in exactly one of two states:
`client.release()` (after a successful `resetConnectionState` /
`DISCARD ALL`) or `client.release(true)` (destroy, never returned to the
pool) when the connection's state is uncertain. **Verified**:
`rls-matrix.integration.spec.ts` tests 1-4 cover commit, rollback, a thrown
`(null as any).boom()` exception, and a forced `pg_terminate_backend` on the
connection's own backend, respectively - all four pass, including the pool
remaining usable by a subsequent call afterward in every case.

### 7. Connection cleanup is safe

Two independent layers, per Architecture §8: `DISCARD ALL` before every
release, and a pool-level `'error'` handler (`attachPoolErrorHandler`) plus
a per-transaction client-level `'error'` listener so a connection dropped
outside `withOrgContext`'s own control flow (an idle client in the pool, or
the active client during the query itself) can never crash the process via
an unhandled `EventEmitter` `'error'` event - both were real gaps found
empirically while writing the connection-drop test (see the P0 report).

## Conclusion

Every guarantee the task brief asked this ADR to confirm holds, for
everything that exists in P0. Two of them (`Kysely` releasing the pinned
connection out from under us, and the shared-pool `db.destroy()` calls in
the installation service/repository) did NOT hold on first implementation -
both were found by writing and running real tests against real Postgres,
not by inspection alone, and both are fixed and now covered by regression
tests. Item 5 is honestly scoped as not-yet-applicable rather than
described as verified.
