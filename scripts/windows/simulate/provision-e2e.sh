#!/usr/bin/env bash
# Runs the REAL provision-postgres.ps1 (PowerShell 7 on Linux) through: fresh install -> upgrade with a new
# migration -> repair with missing settings file -> the two refusal cases. PostgreSQL 16 stands in for 17 through
# small shims named like the Windows executables (postgres.exe --version reports 17 only so the script's version
# guard passes; everything else is the real PostgreSQL tools). Needs root, pwsh, postgresql-16, node 20.
set -euo pipefail
W="${1:?workdir}"; REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
NODE="${NODE:-$(command -v node)}"; PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"; PWSH="${PWSH:-pwsh}"
PORT="${PGPORT:-5545}"
rm -rf "$W"; mkdir -p "$W/bin" "$W/inst" "$W/data"
DATA="$W/data"; INST="$W/inst"; PGDATA="$DATA/postgresql-data"
mkdir -p "$INST/api/apps/api" "$INST/api/apps/web"; cp -r "$REPO/apps/api/dist" "$INST/api/apps/api/dist"
cp -r "$REPO/apps/api/src/db/migrations" "$INST/api/apps/api/dist/db/migrations"
ln -s "$REPO/node_modules" "$INST/api/node_modules"; ln -s "$REPO/apps/api/node_modules" "$INST/api/apps/api/node_modules"
mkdir -p "$W/keys"; (cd "$REPO/apps/api" && npx ts-node scripts/licence-tool.ts keygen --out "$W/keys" >/dev/null)
cp "$W/keys/licence-public.pem" "$INST/licence-public-key.txt"
mkdir -p "$PGDATA"; chown postgres "$PGDATA"; chmod 700 "$PGDATA"; chmod 755 "$W" "$DATA"

# shims: pg tools that refuse root run as the postgres user; --pwfile is copied somewhere that user can read
mk() { printf '#!/bin/sh\n%s\n' "$2" > "$W/bin/$1.exe"; chmod +x "$W/bin/$1.exe"; }
mk postgres "[ \"\$1\" = \"--version\" ] && { echo 'postgres (PostgreSQL) 17.11'; exit 0; }; exec runuser -u postgres -- $PGBIN/postgres \"\$@\""
mk initdb "args=''; for a in \"\$@\"; do case \"\$a\" in --pwfile=*) f=\"\${a#--pwfile=}\"; cp \"\$f\" /tmp/hxprov-pw && chmod 644 /tmp/hxprov-pw; a=\"--pwfile=/tmp/hxprov-pw\";; esac; set -- \"\$@\" \"\$a\"; shift; done; runuser -u postgres -- $PGBIN/initdb \"\$@\"; rc=\$?; rm -f /tmp/hxprov-pw; exit \$rc"
mk pg_ctl "exec runuser -u postgres -- $PGBIN/pg_ctl \"\$@\""
mk psql "exec $PGBIN/psql \"\$@\""
mk pg_dump "exec $PGBIN/pg_dump \"\$@\""

run() { $PWSH -NoProfile -File "$REPO/scripts/windows/provision-postgres.ps1" -PgBinPath "$W/bin" -DataDir "$PGDATA" -Port "$PORT" \
  -RunMigrations -MigratePayloadDir "$INST/api" -NodeExe "$NODE" -InstallDir "$INST" -DataRoot "$DATA" -LicenceKeyFile "$INST/licence-public-key.txt" -WebPort 3000 "$@"; }
ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; exit 1; }
psqlq() { PGPASSWORD="$(grep '^HEXYRN_MIGRATE_DB_PASSWORD=' "$DATA/config/database.env" | cut -d= -f2- | tr -d '\r')" "$PGBIN/psql" -qtA -U hexyrn -h 127.0.0.1 -p "$PORT" -d hexyrn_core -c "$1"; }

echo "== 0. failure handling on a fresh machine =="
python3 -c "import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',$PORT));s.listen();time.sleep(25)" &
BLOCKER=$!; sleep 1
run > "$W/port.log" 2>&1 && bad "ran although the database port was occupied" || { grep -q "already taken" "$W/port.log" && ok "occupied port: clear message, nothing created"; }
[ ! -e "$DATA/config/database.env" ] && [ -z "$(ls -A "$PGDATA")" ] && ok "occupied port left no files behind" || bad "files left behind after port refusal"
kill $BLOCKER 2>/dev/null; wait $BLOCKER 2>/dev/null || true
LASTM=$(ls "$INST/api/apps/api/dist/db/migrations" | sort | tail -1); BADN=$(printf "%04d_broken.sql" $(( 10#${LASTM:0:4} + 1 )))
echo "THIS IS NOT SQL;" > "$INST/api/apps/api/dist/db/migrations/$BADN"
run > "$W/failmid.log" 2>&1 && bad "ran although a migration was broken" || ok "a failing migration fails the provisioning (installer would roll back)"
[ ! -e "$DATA/config/database.env" ] && [ ! -e "$DATA/config/hexyrn.env" ] && [ -z "$(ls -A "$PGDATA")" ] && ok "partial database and credentials were cleaned up" || bad "partial install left behind"
su postgres -c "$PGBIN/pg_ctl status -D '$PGDATA'" >/dev/null 2>&1 && bad "database left running" || ok "no database process left running"
rm "$INST/api/apps/api/dist/db/migrations/$BADN"
echo "== 1. fresh install (retry after the failure) =="
run > "$W/fresh.log" 2>&1 || { tail -30 "$W/fresh.log"; bad "fresh provisioning ran"; }
[ -f "$DATA/config/hexyrn.env" ] && [ -f "$DATA/config/database.env" ] && ok "fresh install wrote credentials and the settings file" || bad "settings files"
grep -q "^listen_addresses = 'localhost'" "$PGDATA/postgresql.conf" && grep -q "^logging_collector = on" "$PGDATA/postgresql.conf" && ok "postgresql.conf: loopback only + file logging" || bad "conf"
su postgres -c "$PGBIN/pg_ctl status -D '$PGDATA'" >/dev/null 2>&1 && bad "temporary instance left running" || ok "temporary instance was stopped again (the service owns startup)"
H1=$(sha256sum "$DATA/config/hexyrn.env" "$DATA/config/database.env" | awk '{print $1}' | tr '\n' ' ')
su postgres -c "$PGBIN/pg_ctl start -D '$PGDATA' -l '$PGDATA/svc.log' -w" >/dev/null
psqlq "CREATE TABLE IF NOT EXISTS upgrade_marker(v text); INSERT INTO upgrade_marker VALUES ('customer data')" >/dev/null
su postgres -c "$PGBIN/pg_ctl stop -D '$PGDATA' -m fast -w" >/dev/null

echo "== 2. upgrade: new version carries an extra migration =="
LAST=$(ls "$INST/api/apps/api/dist/db/migrations" | sort | tail -1); N=$(( 10#${LAST:0:4} + 1 )); NEW=$(printf "%04d_upgrade_probe.sql" "$N")
echo "CREATE TABLE upgrade_probe (id int);" > "$INST/api/apps/api/dist/db/migrations/$NEW"
run > "$W/upgrade.log" 2>&1 || { tail -30 "$W/upgrade.log"; bad "upgrade ran"; }
ls "$DATA/backups"/pre-upgrade-*.dump >/dev/null 2>&1 && ok "a database backup was taken BEFORE the upgrade" || bad "pre-upgrade backup"
[ "$(sha256sum "$DATA/config/hexyrn.env" "$DATA/config/database.env" | awk '{print $1}' | tr '\n' ' ')" = "$H1" ] && ok "secrets and settings were not regenerated" || bad "settings changed"
su postgres -c "$PGBIN/pg_ctl start -D '$PGDATA' -l '$PGDATA/svc.log' -w" >/dev/null
[ "$(psqlq "SELECT count(*) FROM upgrade_marker")" = "1" ] && ok "existing customer data is intact" || bad "data lost"
[ "$(psqlq "SELECT to_regclass('public.upgrade_probe') IS NOT NULL")" = "t" ] && ok "the new migration was applied" || bad "migration not applied"
su postgres -c "$PGBIN/pg_ctl stop -D '$PGDATA' -m fast -w" >/dev/null

echo "== 3. repair: settings file deleted =="
cp "$DATA/config/hexyrn.env" "$W/hexyrn.env.orig"; rm "$DATA/config/hexyrn.env"
run > "$W/repair.log" 2>&1 || { tail -30 "$W/repair.log"; bad "repair ran"; }
[ -f "$DATA/config/hexyrn.env" ] && cmp -s "$DATA/config/hexyrn.env" "$W/hexyrn.env.orig" && ok "repair restored an identical settings file from the existing credentials" || bad "repair"

echo "== 4. refusals =="
mv "$DATA/config/database.env" "$W/database.env.saved"
run > "$W/r1.log" 2>&1 && bad "ran with credentials missing" || { grep -q "credentials file" "$W/r1.log" && ok "database present but credentials missing: refused (no new passwords)"; }
mv "$W/database.env.saved" "$DATA/config/database.env"
mv "$PGDATA" "$W/pgdata.saved"
run > "$W/r2.log" 2>&1 && bad "created an empty database over an existing install" || { grep -q "Refusing to create a new empty database" "$W/r2.log" && ok "settings present but database gone: refused (no silent fresh database)"; }
mv "$W/pgdata.saved" "$PGDATA"
echo "== 5. upgrade whose migration fails =="
echo "NOT SQL;" > "$INST/api/apps/api/dist/db/migrations/9999_broken_upgrade.sql"
run > "$W/upfail.log" 2>&1 && bad "upgrade succeeded with a broken migration" || { grep -q "pre-upgrade-.*dump" "$W/upfail.log" && ok "failed upgrade stops and names the safety copy of the data"; }
su postgres -c "$PGBIN/pg_ctl start -D '$PGDATA' -l '$PGDATA/svc.log' -w" >/dev/null
[ "$(psqlq "SELECT count(*) FROM upgrade_marker")" = "1" ] && ok "customer data unchanged after the failed upgrade" || bad "data changed"
su postgres -c "$PGBIN/pg_ctl stop -D '$PGDATA' -m fast -w" >/dev/null
rm "$INST/api/apps/api/dist/db/migrations/9999_broken_upgrade.sql"
echo "ALL PASSED"
