#!/bin/sh
# Uninstall for a Docker-based Hexyrn Core deployment (P3 item 30/31).
# Explicit, interactive, and destructive by design - this is the "how do
# I get rid of this" answer for docker-compose.prod.yml deployments, with
# an unavoidable choice point about what happens to customer data, not a
# silent `docker compose down -v` that deletes a real production database
# without anyone having to say so out loud.
#
# What this does NOT do: touch a native (non-Docker) install, or a future
# Windows installer's uninstall path (see docs/OPERATOR_GUIDE.md and this
# phase's Windows installer groundwork notes - a real Windows uninstaller
# is separate, unstarted work).
set -eu

cd "$(dirname "$0")/.."
COMPOSE_FILE="docker-compose.prod.yml"
# Real bug found testing this script for real: `docker compose` only
# reads a file literally named `.env` in the project directory by
# default - a deployment using a differently-named env file (or one not
# at the repo root) would otherwise hit "required variable ... is missing
# a value" errors on `down` and leave containers running. Accept an
# optional --env-file argument so this works for any deployment layout,
# defaulting to Compose's own standard `.env` lookup when omitted.
COMPOSE_ARGS=""
if [ "${1:-}" = "--env-file" ] && [ -n "${2:-}" ]; then
  COMPOSE_ARGS="--env-file $2"
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "FAIL: $COMPOSE_FILE not found - run this from the Hexyrn Core repository root."
  exit 1
fi

echo "=== Hexyrn Core - Docker deployment uninstall ==="
echo ""
echo "This will stop and remove the running Hexyrn Core containers"
echo "(postgres, api, web) defined in $COMPOSE_FILE."
echo ""
echo "Before continuing, strongly consider:"
echo "  1. Taking a final backup: use the admin Backup screen, or POST /api/v1/backup,"
echo "     then copy the backups volume off this machine."
echo "  2. Exporting organisation data (P2 item 22's Data Portability export -"
echo "     available from the API/UI) if you need it in a portable CSV form,"
echo "     independent of a Postgres-format backup."
echo ""
read -r -p "Stop and remove containers, but KEEP all data volumes (postgres data, uploaded files, backups)? [y/N] " keep_answer
if [ "$keep_answer" != "y" ] && [ "$keep_answer" != "Y" ]; then
  echo "Aborted - nothing was changed."
  exit 0
fi

echo "--- Stopping and removing containers (volumes preserved) ---"
docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS down

echo ""
echo "Containers removed. Data volumes (hexyrn_pg_data, hexyrn_storage,"
echo "hexyrn_backups, hexyrn_caddy_data, hexyrn_caddy_config) were NOT touched -"
echo "list them with: docker volume ls | grep hexyrn"
echo ""
read -r -p "ALSO permanently delete all data volumes? This cannot be undone. [y/N] " delete_answer
if [ "$delete_answer" != "y" ] && [ "$delete_answer" != "Y" ]; then
  echo "Done. Data volumes were kept - re-running 'docker compose up' later will restore this installation's data."
  exit 0
fi

echo "--- Permanently deleting data volumes ---"
docker compose -f "$COMPOSE_FILE" $COMPOSE_ARGS down -v
echo ""
echo "All Hexyrn Core containers and data volumes have been removed."
echo "The Docker images (hexyrn-core*_api, *_web) were left in place -"
echo "remove them separately with 'docker image prune' or 'docker rmi' if desired."
