#!/bin/sh
# Creates the restricted application role Hexyrn Core actually connects as.
#
# P3 item 18 ("verify production DB roles: runtime app role must not be
# superuser, not BYPASSRLS") and the automated check in
# apps/api/src/db/__tests__/db-role-security.integration.spec.ts both
# assume the connecting role is genuinely unprivileged. Before this script
# existed, docker-compose.yml's POSTGRES_USER (`hexyrn`) WAS that connecting
# role - and the official postgres image makes POSTGRES_USER a superuser by
# default, which silently defeats FORCE ROW LEVEL SECURITY for any customer
# who deployed via docker-compose (native/manual Postgres setups were
# already correctly instructed in .env.example to create a separate
# non-superuser role - only the Docker path had this gap).
#
# Postgres only runs docker-entrypoint-initdb.d/* on an EMPTY data
# directory - see docs/DOCKER_DEPLOYMENT.md for what that means for
# existing installs that predate this script. Runs as the POSTGRES_USER
# superuser (that's how initdb scripts are invoked) and creates
# `hexyrn_app`: a login role with NOSUPERUSER and NOBYPASSRLS, granted just
# enough to run the application. It does not own any table itself -
# migrations still run as the superuser/bootstrap role
# (docs/DOCKER_DEPLOYMENT.md), since owning tables is a materially larger
# privilege than being permitted to read/write rows subject to RLS, and
# ownership is not required for the runtime role's job.
# ALSO creates `hexyrn_backup`: a SEPARATE, narrowly-scoped role with
# BYPASSRLS, used ONLY by the backup/restore child process
# (backup.service.ts's realPgDump/realPgRestore) - never by the running
# API server, never exposed to any HTTP request handler. This is a real
# requirement discovered while attempting a genuine pg_dump against a
# FORCE ROW LEVEL SECURITY database (P3 item 13/14): `pg_dump` performs a
# plain `COPY ... TO stdout` per table with NO organisation context set
# (it has no concept of "which org" - a full-database backup must capture
# every organisation's rows), and FORCE ROW LEVEL SECURITY applies even to
# the table OWNER, so a dump connecting as `hexyrn` (or any non-bypassing
# role) fails outright with "query would be affected by row-level security
# policy." This is standard, documented PostgreSQL behaviour, not a bug in
# this codebase - a full-database backup tool legitimately needs to read
# across every row regardless of RLS policy, which is exactly what
# BYPASSRLS exists for. Scoping it to a role used ONLY by the backup
# process (SELECT-only, cannot log in as the application, cannot be
# reached by any code path an HTTP request triggers) keeps this a narrow,
# deliberate, and documented exception - not a weakening of the runtime
# security model verified by db-role-security.integration.spec.ts, which
# asserts the RUNTIME role specifically, not every role that exists.
set -e

HEXYRN_APP_DB_PASSWORD="${HEXYRN_APP_DB_PASSWORD:?HEXYRN_APP_DB_PASSWORD must be set - see .env.example}"
HEXYRN_BACKUP_DB_PASSWORD="${HEXYRN_BACKUP_DB_PASSWORD:?HEXYRN_BACKUP_DB_PASSWORD must be set - see .env.example}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$HEXYRN_APP_DB_PASSWORD" -v backup_password="$HEXYRN_BACKUP_DB_PASSWORD" -v dbname="$POSTGRES_DB" <<-'EOSQL'
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hexyrn_app') THEN
        EXECUTE format(
          'CREATE ROLE hexyrn_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
          :'app_password'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hexyrn_backup') THEN
        EXECUTE format(
          'CREATE ROLE hexyrn_backup WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS',
          :'backup_password'
        );
      END IF;
    END
    $$;

    GRANT CONNECT ON DATABASE :"dbname" TO hexyrn_app;
    GRANT USAGE ON SCHEMA public TO hexyrn_app;

    -- Applies to tables/sequences that exist yet (none, at first container
    -- init - migrations haven't run) AND is set as a default for every
    -- object created hereafter, so a future migration adding a new table
    -- doesn't need a manual grant step to keep hexyrn_app able to use it.
    -- This grants row DML, not ownership - RLS still applies in full,
    -- since RLS is enforced against the querying role regardless of
    -- table-level grants (grants and RLS are independent, composed
    -- controls, not substitutes for one another).
    --
    -- IMPORTANT: "ALTER DEFAULT PRIVILEGES" with no "FOR ROLE" clause only
    -- applies to objects THIS session's role (the superuser running this
    -- init script) creates in the future - NOT to objects a DIFFERENT
    -- role creates. Migrations run as `hexyrn` (MIGRATE_DATABASE_URL), not
    -- as the superuser, so the default-privilege declarations below are
    -- explicitly scoped "FOR ROLE hexyrn" - a superuser is permitted to
    -- set default privileges on behalf of another role - so that tables
    -- `hexyrn` creates via migrations are automatically grant-covered too,
    -- not just tables the init script itself might create (which in
    -- practice is none - this codebase's migrations are the only DDL).
    ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hexyrn_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hexyrn_app;

    -- hexyrn_backup: full DML (SELECT/INSERT/UPDATE/DELETE), across every
    -- row regardless of RLS (that's what BYPASSRLS is for) - needed for
    -- BOTH directions: pg_dump's COPY TO reads every organisation's rows
    -- (SELECT), and pg_restore's COPY FROM writes them back (INSERT) -
    -- FORCE ROW LEVEL SECURITY applies symmetrically to writes too, so a
    -- restore under a non-bypassing role would fail INSERT the same way a
    -- dump fails SELECT. Same "FOR ROLE hexyrn" scoping as above.
    --
    -- TRUNCATE is ALSO granted: confirmed by real execution
    -- (P3 item 13/14 acceptance testing) that pg_restore's own
    -- `--disable-triggers` flag requires TABLE OWNERSHIP (which this role
    -- deliberately does not have) to reorder FK-dependent data-only
    -- restores, and `--clean` cannot be combined with `--data-only` at
    -- all. realPgRestore() instead empties every table with a single
    -- `TRUNCATE ... CASCADE` before invoking pg_restore, which resolves
    -- FK dependency order itself and needs only the TRUNCATE privilege
    -- (a grantable DML-adjacent privilege, not ownership) - see
    -- backup.service.ts's realPgRestore() doc comment for the full
    -- reasoning.
    GRANT CONNECT ON DATABASE :"dbname" TO hexyrn_backup;
    GRANT USAGE ON SCHEMA public TO hexyrn_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO hexyrn_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE hexyrn IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hexyrn_backup;
EOSQL
