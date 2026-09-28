# Docker deployment notes (P3 item 4, in progress)

This file documents the Postgres role model introduced alongside
`docker-compose.yml` and `docker/postgres-init/01-app-role.sh`, as part of
P3 item 18's database-role security review. It is a starting point for the
fuller P3 item 4 (Docker deployment) documentation, not the complete guide
yet - production TLS/reverse-proxy, volumes for uploaded files, and backup
implications are tracked separately and not all written up here.

## Two Postgres roles, not one

`docker-compose.yml` provisions Postgres with `POSTGRES_USER=hexyrn`
(required by the official image - it always becomes a superuser) and then
runs `docker/postgres-init/01-app-role.sh` on first container init, which
creates a second role, `hexyrn_app`:

| Role         | Privileges                                                                                                      | Used for                       | Env var                |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------- |
| `hexyrn`     | Superuser (image default), owns every table after migrations run                                                | `npm run migrate` only         | `MIGRATE_DATABASE_URL` |
| `hexyrn_app` | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, granted `SELECT/INSERT/UPDATE/DELETE` via default privileges | The running API server, always | `DATABASE_URL`         |

**Why two roles:** Architecture §8's entire RLS design assumes the
connecting role cannot bypass row-level security. A superuser always can,
regardless of `FORCE ROW LEVEL SECURITY`. Before this change, the API
server connected as `hexyrn` (the same role Docker's official Postgres
image makes a superuser) - meaning a self-hosted Docker deployment's RLS
protection was silently inert, even though `FORCE ROW LEVEL SECURITY` was
correctly applied to every organisation-owned table and every RLS
integration test passed (a superuser reading a single organisation's test
fixtures returns the same rows RLS would have returned anyway - the test
can't distinguish "RLS enforced it" from "RLS was irrelevant because the
role bypasses it"). This is exactly the false-confidence failure mode P3
item 18 names. Native/manual Postgres installs (not using this
docker-compose file) were already correctly instructed in `.env.example`
to create a single non-superuser role - only the Docker path had this gap.

`hexyrn_app` does not own any table. Ownership is not required to read/
write rows subject to RLS policies - table-level grants (`SELECT`,
`INSERT`, etc.) and row-level security are independent, composed access
controls in Postgres, not substitutes for one another. `hexyrn_app`
therefore cannot run migrations (no `CREATE`/`ALTER TABLE`), which is the
intended blast-radius reduction: a vulnerability in the running API
process that leaked its DB credentials would not, by itself, let an
attacker alter the schema, disable `FORCE ROW LEVEL SECURITY`, or drop
tables.

## Password configuration

`HEXYRN_APP_DB_PASSWORD` is a container environment variable (set in
`docker-compose.yml` for local dev/test with placeholder values -
`hexyrn_app_dev_password` / `hexyrn_app_test_password`) consumed only by
the init script when it creates `hexyrn_app`. **For a real deployment,
override it** (and `POSTGRES_PASSWORD`) with generated secrets before
first container start - see the top-level installation-secrets guidance
(P3 item 7, not yet fully written) for how these fit alongside
`SESSION_SECRET`/`TOTP_MASTER_KEY`/etc.

## Important: init scripts only run on an EMPTY data volume

Postgres only executes `docker-entrypoint-initdb.d/*` scripts the very
first time a data directory is initialized. **An existing Hexyrn Core
Docker deployment that predates this change will NOT automatically gain
the `hexyrn_app` role** - its Postgres data volume already exists. For an
existing installation, an administrator must run the equivalent of
`docker/postgres-init/01-app-role.sh`'s SQL manually against the running
database (connected as the existing superuser), then update `DATABASE_URL`
to point at the new role and restart the API container. This migration
path is not yet automated - tracked as follow-up P3 work (belongs with the
Update System, item 14/15, since it is exactly the kind of "upgrade must
handle a schema/config change safely" case that system is for).

## Verifying the role split is actually in effect

`apps/api/src/db/__tests__/db-role-security.integration.spec.ts` asserts,
against whatever `TEST_DATABASE_URL` (or, by the same logic, `DATABASE_URL`
in a production health check - not yet wired up, see P3 item 19) actually
connects as: the role is not a superuser, does not have `BYPASSRLS`, and
every organisation-owned table has RLS both enabled and forced. This is
the automated version of the check this document describes - run it
against a production database's runtime role, not just the test database,
before considering a deployment's RLS protection verified.
