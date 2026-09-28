#!/usr/bin/env bash
# LINUX SIMULATION of a Windows install, for developers/CI. It is NOT a substitute for the clean-VM test.
# It runs the REAL pieces that are not Windows-specific, in the order the installer runs them:
#   generate-credentials.ps1 -> initdb (scram) -> the role SQL from provision-postgres.ps1 -> migrations
#   -> write-runtime-config.js (the real hexyrn.env) -> the app started from that settings file only.
# What it cannot exercise: MSI, WinSW, Windows services, ACLs, firewall, reboot.
# Usage: sim-install.sh <workdir> [--rebuild]   (needs: pwsh, postgresql-16 binaries, node 20, root)
set -euo pipefail
W="${1:?workdir}"; REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
NODE="${NODE:-$(command -v node)}"; PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"; PWSH="${PWSH:-pwsh}"
PGPORT="${PGPORT:-5544}"; WEBPORT="${WEBPORT:-3000}"
INST="$W/Program Files/Hexyrn Core"; DATA="$W/ProgramData/Hexyrn Core"; CFG="$DATA/config"
rm -rf "$W"; mkdir -p "$INST/api/apps/api" "$INST/api/apps/web" "$CFG" "$DATA/storage" "$DATA/backups" "$DATA/logs" "$W/keys"

if [ "${2:-}" = "--rebuild" ] || [ ! -d "$REPO/apps/api/dist" ]; then
  (cd "$REPO/apps/api" && npx tsc -p tsconfig.json) && (cd "$REPO/apps/web" && npx vite build >/dev/null)
fi
cp -r "$REPO/apps/api/dist" "$INST/api/apps/api/dist"; cp "$REPO/apps/api/package.json" "$INST/api/apps/api/"
cp -r "$REPO/apps/api/src/db/migrations" "$INST/api/apps/api/dist/db/migrations"
cp -r "$REPO/apps/web/dist" "$INST/api/apps/web/dist"
ln -s "$REPO/node_modules" "$INST/api/node_modules"
ln -s "$REPO/apps/api/node_modules" "$INST/api/apps/api/node_modules"

# vendor side: a licence keypair. Only the PUBLIC half is given to the "installer".
(cd "$REPO/apps/api" && npx ts-node scripts/licence-tool.ts keygen --out "$W/keys" >/dev/null)
cp "$W/keys/licence-public.pem" "$INST/licence-public-key.txt"

$PWSH -NoProfile -File "$REPO/scripts/windows/generate-credentials.ps1" -NoAcl -OutFile "$CFG/database.env" >/dev/null
getv() { grep "^$1=" "$CFG/database.env" | cut -d= -f2- | tr -d "\r"; }

mkdir -p "$W/pgdata"; chown postgres "$W/pgdata"; chmod 700 "$W/pgdata"
getv HEXYRN_MIGRATE_DB_PASSWORD > "$W/pw"; chown postgres "$W/pw"
su postgres -c "$PGBIN/initdb --username=hexyrn --pwfile='$W/pw' --auth=scram-sha-256 --encoding=UTF8 -D '$W/pgdata' >/dev/null"
rm -f "$W/pw"
printf "\nlisten_addresses = 'localhost'\nport = %s\nunix_socket_directories = '%s'\n" "$PGPORT" "$W/pgdata" >> "$W/pgdata/postgresql.conf"
su postgres -c "$PGBIN/pg_ctl start -D '$W/pgdata' -l '$W/pgdata/pg.log' -w -t 60" >/dev/null

# the role SQL is taken straight out of the installer's provisioning script
sed -n '/^ *\$roleSql = @"/,/^"@/p' "$REPO/scripts/windows/provision-postgres.ps1" | sed '1d;$d' > "$W/roles.sql"
[ -s "$W/roles.sql" ] || { echo "could not extract the role SQL from provision-postgres.ps1" >&2; exit 1; }
PGPASSWORD="$(getv HEXYRN_MIGRATE_DB_PASSWORD)" "$PGBIN/psql" -q -v ON_ERROR_STOP=1 -U hexyrn -h 127.0.0.1 -p "$PGPORT" -d postgres \
  -v app_password="$(getv HEXYRN_APP_DB_PASSWORD)" -v backup_password="$(getv HEXYRN_BACKUP_DB_PASSWORD)" -f "$W/roles.sql" >/dev/null
MIGRATE_DATABASE_URL="postgres://hexyrn:$(getv HEXYRN_MIGRATE_DB_PASSWORD)@127.0.0.1:$PGPORT/hexyrn_core" "$NODE" "$INST/api/apps/api/dist/db/migrate.js" >/dev/null

"$NODE" "$INST/api/apps/api/dist/config/write-runtime-config.js" --credentials "$CFG/database.env" \
  --licence-key-file "$INST/licence-public-key.txt" --install-dir "$INST" --data-dir "$DATA" \
  --pg-port "$PGPORT" --web-port "$WEBPORT" --out "$CFG/hexyrn.env"
# Linux has no pg_dump.exe; point the app at the Linux tools instead
sed -i "s#^PG_DUMP_PATH=.*#PG_DUMP_PATH=$PGBIN/pg_dump#; s#^PG_RESTORE_PATH=.*#PG_RESTORE_PATH=$PGBIN/pg_restore#" "$CFG/hexyrn.env"

cat > "$W/service.sh" <<SVC
#!/bin/sh
# the "service": only the settings-file path in the environment, exactly like the WinSW definition
cd /
exec env -i PATH=/usr/bin:/bin HEXYRN_ENV_FILE="$CFG/hexyrn.env" "$NODE" "$INST/api/apps/api/dist/main.js"
SVC
chmod +x "$W/service.sh"
echo "simulated install ready in $W"
