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
set -e

HEXYRN_APP_DB_PASSWORD="${HEXYRN_APP_DB_PASSWORD:?HEXYRN_APP_DB_PASSWORD must be set - see .env.example}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$HEXYRN_APP_DB_PASSWORD" -v dbname="$POSTGRES_DB" <<-'EOSQL'
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hexyrn_app') THEN
        EXECUTE format(
          'CREATE ROLE hexyrn_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
          :'app_password'
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
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hexyrn_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hexyrn_app;
EOSQL
