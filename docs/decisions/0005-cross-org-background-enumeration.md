# ADR 0005: Cross-organisation background work enumeration via a non-RLS routing queue

## Status

Accepted (P1).

## The problem

Architecture §8's RLS design (verified and hardened in P0) deliberately
gives the application's database role no way to read across organisations:
`FORCE ROW LEVEL SECURITY` applies even to the table owner, the connecting
role is confirmed non-superuser and non-`BYPASSRLS`, and every read
requires `withOrgContext(organisationId, ...)` with an already-known,
specific `organisationId`.

P1's event dispatcher and scheduled-job runner have a genuine, structural
need that doesn't fit that model directly: **before** they can call
`withOrgContext` for any one organisation, they need to discover _which_
organisations have due work at all - "poll for anything pending, across
every org, then process each." A plain `SELECT * FROM event_outbox WHERE
dispatched_at IS NULL` against an RLS-protected table run with no org
context returns zero rows every time (fail-closed, exactly as intended) -
it cannot be used for this.

## Options considered

1. **A separate, more-privileged database role for background workers**
   (`BYPASSRLS`), used only by the dispatcher/runner. Rejected: this
   reintroduces exactly the class of risk P0's RLS work was designed to
   close - a role that CAN read cross-org data means a bug in the
   dispatcher/runner code (not just a bug in a request handler) could leak
   or corrupt data across organisations, and it can no longer be verified
   "this connection literally cannot see another org's rows" the way P0's
   `rls-matrix.integration.spec.ts` tests do today.
2. **A non-RLS routing queue holding only pointers** (chosen). A tiny table
   - `organisation_id`, `kind`, `ref_id`, `due_at` - with no payload and no
     RLS policy, populated in the SAME transaction as the real (RLS-protected)
     event/job row. This is architecturally identical to the existing,
     already-reviewed precedent: `installations` and `bootstrap_tokens` have
     no RLS because Architecture §7 states they are "not itself
     organisation-owned data." A routing pointer - "organisation X has event Y
     pending" - carries no business information (no payload, no entity
     details) and is the same kind of installation-level operational metadata.
3. **Have every organisation register its own scheduled poll** (no shared
   cross-org discovery at all - e.g. a cron-like registration per org that
   the runner iterates using a known, pre-enumerated org list). Rejected as
   strictly more complex than option 2 for the same result, and it still
   needs SOME way to know the list of organisations in the first place,
   which has the identical problem one level up.

## Decision

`dispatch_queue` (migration `0022`), no RLS. `EventPublisherService.publish`
and `ScheduledJobService.enqueue` each insert one row here in the same
transaction as their real (RLS-protected) `event_outbox`/`scheduled_jobs`
row. `EventDispatcherService.dispatchPending` and the job runner read
`dispatch_queue` directly (safe - it contains no payload, only pointers),
then immediately call `withOrgContext(row.organisation_id, ...)` to do
every subsequent operation - loading the real event/job, checking consumer/
app state, invoking handlers, writing delivery/attempt records - fully
inside the normal RLS-protected, organisation-context-required path. The
routing table narrows the "read without org context" surface to the
absolute minimum (an id and a timestamp), and every access to actual data
still goes through `withOrgContext`, satisfying Architecture §8.1's
invariant ("every execution context accessing organisation-owned data must
have an explicit organisation context") for the data itself, while solving
the one problem that invariant doesn't (and shouldn't) solve on its own:
discovering which organisation to start with.

## Consequences

- `dispatch_queue` rows are deleted (or marked claimed then deleted) once
  processed, so the table stays small - it is not an audit log or a
  historical record, purely a work queue.
- If a `dispatch_queue` row and its corresponding `event_outbox`/
  `scheduled_jobs` row ever disagree (e.g. the detail row was deleted but
  the queue row wasn't), the dispatcher/runner's `withOrgContext` read of
  the detail row returns nothing and the queue row is discarded - fail-soft,
  never fail-open.
