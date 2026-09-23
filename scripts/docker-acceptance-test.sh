#!/bin/sh
# Docker deployment acceptance test (P3 items 3/4/47's automatable Docker
# portion). Automates exactly the sequence that was run manually, by hand,
# to genuinely verify docker-compose.prod.yml this phase (see
# P3-ENVIRONMENT-VERIFICATION.md's "Docker deployment" section) - real
# `docker build`, real `docker compose up`, real migrations, real role
# checks, real HTTP probes through the real Caddy reverse proxy. Not a
# placeholder: every step below was exercised by hand first and is
# reproduced here verbatim so it can be re-run (locally, or in a future CI
# job with a Docker-in-Docker runner) instead of only ever being proven
# once, interactively.
#
# Requires: a working Docker daemon (`docker info` must succeed) and
# Docker Compose v2 (`docker compose version`). Exits non-zero on ANY
# failure - set -e, no swallowed errors.
set -eu

cd "$(dirname "$0")/.."
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE="$(mktemp)"
PROJECT="hexyrn_docker_acceptance"

cleanup() {
  echo "--- Tearing down acceptance stack ---"
  docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

echo "--- Checking Docker availability ---"
docker info >/dev/null || { echo "FAIL: Docker daemon not reachable."; exit 1; }
docker compose version >/dev/null || { echo "FAIL: docker compose (v2) not available."; exit 1; }

echo "--- Generating throwaway .env for this run (never committed, never real secrets) ---"
TOTP_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=acceptance_pg_$(date +%s)
HEXYRN_APP_DB_PASSWORD=acceptance_app_$(date +%s)
HEXYRN_BACKUP_DB_PASSWORD=acceptance_backup_$(date +%s)
HEXYRN_SESSION_SECRET=acceptance_session_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
TOTP_MASTER_KEY_CURRENT=$TOTP_KEY
HEXYRN_LICENSE_PUBLIC_KEY=acceptance_test_license_pub_key
HEXYRN_PUBLIC_HOSTNAME=localhost
EOF

echo "--- Building images ---"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" build postgres migrate api web

echo "--- Bringing up postgres, migrate, api ---"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" up -d postgres migrate api

echo "--- Waiting for migrate to complete ---"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" wait migrate >/dev/null 2>&1 || true
MIGRATE_EXIT=$(docker inspect "${PROJECT}-migrate-1" --format '{{.State.ExitCode}}' 2>/dev/null || echo 1)
if [ "$MIGRATE_EXIT" != "0" ]; then
  echo "FAIL: migrate container exited with code $MIGRATE_EXIT"
  docker logs "${PROJECT}-migrate-1" || true
  exit 1
fi
echo "PASS: migrate applied cleanly (exit 0)."

echo "--- Waiting for api to become healthy (up to 60s) ---"
i=0
until [ "$(docker inspect "${PROJECT}-api-1" --format '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ]; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "FAIL: api never became healthy."
    docker logs "${PROJECT}-api-1" || true
    exit 1
  fi
  sleep 2
done
echo "PASS: api container is healthy."

echo "--- Verifying real Postgres roles (hexyrn_app non-superuser/non-bypassrls, hexyrn_backup bypassrls-only) ---"
# Real bug found running this script for the first time: psql -t prints
# boolean columns as the literal words "true"/"false" in this
# environment's psql build, not the single-character "t"/"f" shorthand
# this script originally assumed - the grep below is matched against the
# actual observed output, not an assumption.
ROLES=$(docker exec "${PROJECT}-postgres-1" psql -U hexyrn -d hexyrn_core -t -c \
  "SELECT rolname || ':' || rolsuper || ':' || rolbypassrls FROM pg_roles WHERE rolname IN ('hexyrn_app','hexyrn_backup') ORDER BY rolname")
echo "$ROLES"
echo "$ROLES" | grep -q "hexyrn_app:false:false" || { echo "FAIL: hexyrn_app does not have the expected non-superuser/non-bypassrls privileges."; exit 1; }
echo "$ROLES" | grep -q "hexyrn_backup:false:true" || { echo "FAIL: hexyrn_backup does not have the expected non-superuser/bypassrls privileges."; exit 1; }
echo "PASS: both Postgres roles created with correct privileges."

echo "--- Bringing up web (Caddy + SPA) ---"
docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" up -d web
sleep 5

echo "--- Probing SPA through Caddy (expect 200) ---"
SPA_CODE=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/)
[ "$SPA_CODE" = "200" ] || { echo "FAIL: SPA returned HTTP $SPA_CODE, expected 200."; exit 1; }
echo "PASS: SPA served (HTTP 200)."

echo "--- Probing API health through Caddy's reverse proxy (expect 200 + status:ok) ---"
HEALTH_BODY=$(curl -sk https://localhost/api/v1/health)
echo "$HEALTH_BODY" | grep -q '"status":"ok"' || { echo "FAIL: health endpoint did not return status:ok - got: $HEALTH_BODY"; exit 1; }
echo "PASS: API health reachable through the reverse proxy."

echo ""
echo "=== Docker deployment acceptance test: ALL CHECKS PASSED ==="
