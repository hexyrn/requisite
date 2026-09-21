# ADR 0001: Database layer — raw `pg` + Kysely + hand-written SQL migrations

## Status
Accepted (P0).

## Decision
Hexyrn Core uses `pg` (node-postgres) as the driver, [Kysely](https://kysely.dev) as a
type-safe SQL query builder on top of it, and a small hand-written, versioned SQL
migration runner (`apps/api/src/db/migrate.ts`), instead of Prisma.

## Why not Prisma
Architecture §8 requires that every organisation-scoped query run inside a transaction
that issues `SET LOCAL app.current_organisation_id = $1` as its first statement, via one
wrapper (`withOrgContext`), and that this cannot be bypassed. Prisma's `$transaction`
API only recently (and only in an interactive-callback form, `prisma.$transaction(async (tx) => {...})`)
allows raw queries against the *same* connection used for the rest of the callback's
queries. This works, but it means:

- Every single Prisma model call inside the callback still goes through Prisma's own
  query engine/connection handling, so we would be trusting a second abstraction layer
  (on top of our own wrapper) to never issue a query outside the transaction's bound
  connection.
- Prisma's migration tool (`prisma migrate dev`) is diff-based by default; achieving
  "explicit versioned migrations, not just auto-diff" (task requirement) means fighting
  the tool's default workflow rather than using it as intended.
- Enabling and testing RLS policies (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) sits
  outside Prisma's schema language entirely and has to be hand-written SQL either way.

## Why `pg` + Kysely
- `pg`'s `pool.connect()` gives us a single physical `PoolClient` for the lifetime of a
  transaction; `withOrgContext` runs `BEGIN`, `SET LOCAL app.current_organisation_id = $1`,
  the callback (receiving that same client, wrapped by a Kysely instance bound to it),
  then `COMMIT`/`ROLLBACK`, and finally releases the client back to the pool after running
  `DISCARD ALL` — exactly the mechanism Architecture §8 specifies, with nothing hidden
  behind an ORM's own connection pooling.
- Kysely gives us generated TypeScript types for query results (from a hand-maintained
  `Database` interface, see `apps/api/src/db/types.ts`) without owning migrations or
  connection management — it is a query *builder*, not a full ORM, so it does not fight
  the transaction model above.
- Migrations are plain `.sql` files applied in filename order by a ~80-line runner that
  records applied migrations in a `schema_migrations` table, wrapped in a transaction per
  file. This is explicit and inspectable, matching "explicit versioned migrations, not
  just auto-diff" from the task brief.

## Verified
Before committing to this approach, a manual proof was run (see
`apps/api/src/db/__tests__/set-local.integration.spec.ts`) confirming that
`SET LOCAL` issued as the first statement after `BEGIN` on a `pg.PoolClient` is visible
to subsequent queries on that same client within the transaction, and is not visible
after `COMMIT`/`ROLLBACK` when the same underlying connection is later reused for a
different transaction. This is the load-bearing property the whole RLS design depends on.

## Consequences
- We own a small amount of migration-runner and query-typing code that a framework would
  otherwise provide. This is an accepted, bounded cost in exchange for the transaction
  model being fully explicit and auditable.
- Kysely's `Database` type map is hand-maintained alongside migrations. For P0's table
  count this is manageable; if it becomes a maintenance burden later, generating it from
  the migrations (e.g. via `kysely-codegen`) is a non-breaking follow-up, not an
  architectural change.
