# Hexyrn Core - Operator Guide (P3 item 41)

For a competent SME IT administrator installing, running, and maintaining
a self-hosted Hexyrn deployment. No source-code knowledge required for any
procedure below. Where a procedure's real-environment verification is
still pending (Windows/Docker execution, real `pg_dump`/`pg_restore`), it
is marked **[VERIFICATION PENDING]** and cross-referenced to
`P3-ENVIRONMENT-VERIFICATION.md` - do not treat those as untested-and-
therefore-broken, but as "implemented, awaiting the correct environment to
confirm."

## 1. System requirements

- **Node.js**: 20.x (see root `package.json`'s `engines` field).
- **PostgreSQL**: 17 - Hexyrn's officially supported database major
  version for Core/Requisite 1.0 (`docker-compose.yml`/
  `docker-compose.prod.yml`'s `postgres:17-alpine` image, and the version
  the Windows installer's bundled-PostgreSQL design targets - see
  `docs/WINDOWS_INSTALLER_DESIGN.md`). Not tested against other major
  versions.
- **Package manager**: npm (workspaces) - the only supported one; no
  yarn/pnpm lockfile is maintained.
- **OS**: Linux (primary target for Docker/self-hosted deployment) or
  Windows (installer planned, not yet built - see §3).

## 2. Installation

### 2.1 Docker (recommended today)

See `docs/DOCKER_DEPLOYMENT.md` for the full role-security model
(`hexyrn` migration role vs restricted `hexyrn_app` runtime role) and
`docker-compose.yml` for the current dev/test compose file. **[VERIFICATION
PENDING - no Docker daemon available in the sandbox this was authored
in]**: the compose file has been reviewed and its SQL-level role logic
tested against a real (non-containerized) Postgres, but `docker compose up`
itself has never been run end to end. A production-oriented compose file
(application container + reverse-proxy example) is not yet written -
tracked in `P3-ENVIRONMENT-VERIFICATION.md`.

### 2.2 Windows

**Compiled, not yet clean-machine tested.** The installer (WiX 4.0.6 -
`installer/windows/Product.wxs` + `installer/windows/Bundle.wxs`)
genuinely compiles into a real MSI + Burn bundle bundling PostgreSQL 17
and Node.js 20 so a customer never needs to install either separately -
see `P3-ENVIRONMENT-VERIFICATION.md`'s "Windows packaging" section for
exact artifact hashes/sizes and what's independently confirmed present
inside the compiled MSI. NOT yet installed/tested on any real machine
(deliberately reserved for a clean VirtualBox VM, never the development
machine) - this guide will be updated with the real, tested install
procedure once that clean-machine acceptance pass completes.

### 2.3 Manual / bare-metal

1. Provision PostgreSQL 17. Create the schema-owning role (matching
   `docker/postgres-init/01-app-role.sh`'s SQL by hand if not using
   Docker) and the restricted runtime role - see `.env.example`'s
   `DATABASE_URL` vs `MIGRATE_DATABASE_URL` comments for exactly which
   role each is expected to be.
2. Copy `.env.example` to `.env` and fill in every value - each variable
   is documented inline, including which ones are REQUIRED in production
   (`NODE_ENV=production` triggers `apps/api/src/config/production-config-check.ts`,
   which refuses to start if `TOTP_MASTER_KEY_CURRENT`,
   `HEXYRN_LICENSE_PUBLIC_KEY`, or `DATABASE_URL` are missing/invalid -
   deliberately fail-fast rather than boot into a silently insecure state).
3. Run migrations: `npm run migrate --workspace apps/api` (uses
   `MIGRATE_DATABASE_URL`, the schema-owning role).
4. Build: `npm run build` (root - builds every workspace).
5. Start: `npm run start --workspace apps/api` (serves the API; the built
   frontend in `apps/web/dist` needs a static file server or reverse
   proxy in front of it - see §4).

## 3. First-run setup

See `docs/BOOTSTRAP.md` for the full secure bootstrap flow (one-time
token, organisation + owner creation, bootstrap permanently disabled
after completion - no "first person to register becomes owner" fallback).
After bootstrap:

1. **SMTP** (optional but recommended) - `Administration -> SMTP`
   (`GET/POST/DELETE /api/v1/smtp`): configure host/port/credentials, then
   use the "send test email" action (`POST /api/v1/smtp/test`) to confirm
   real delivery before relying on it. If skipped, invitation/password-
   reset links are shown directly to the admin to share manually - a
   supported, safe fallback, not a failure state.
2. **Requisite licence import** - `Administration -> Applications ->
   Requisite -> Licence` (`GET/POST /api/v1/apps/com.hexyrn.requisite/licence`):
   import the signed licence file provided with your purchase. No internet
   activation required - verification is entirely offline (Ed25519
   signature check against the locally-configured trusted public key).
3. **Create/invite users** - see `docs/REQUISITE_ADMIN_GUIDE.md` for the
   Requisite-specific roles, or Core's own Users & Access admin screens
   for general user/role management.

## 4. TLS / reverse proxy

Hexyrn Core does not terminate TLS itself - run it behind a standard
reverse proxy (nginx, Caddy, Traefik) that does. Required proxy
configuration:

- Forward `X-Forwarded-For`/`X-Forwarded-Proto` and set
  `TRUSTED_PROXY_CIDRS` to the proxy's own address/CIDR so Fastify trusts
  those headers only from your actual proxy, never from an arbitrary
  client (`apps/api/src/main.ts`'s `parseTrustedProxies()`).
- Set `ALLOWED_ORIGINS` to your public HTTPS URL(s) - this both drives
  CORS and the second-layer Origin/Referer validation on state-changing
  requests (Architecture §6).
- Set `COOKIE_SECURE=true` (checked by the production-config fail-fast
  gate when `NODE_ENV=production`) so session cookies require HTTPS.
- Generated invitation/password-reset links use `ALLOWED_ORIGINS`'
  configured canonical URL, never an attacker-controlled `Host` header -
  set this correctly before inviting real users.

A concrete nginx/Caddy example config is not yet written - tracked as
narrower documentation follow-up.

## 5. Backups

`Administration -> System -> Backup` (`apps/api/src/platform/backup/backup.controller.ts`):

- `POST /api/v1/backup` - Backup Now. Writes to `HEXYRN_BACKUP_DIR`
  (default `./backups`) under a timestamped subdirectory.
- `GET /api/v1/backup` - list every backup with its integrity status
  (last successful backup / backup health at a glance).
- `GET /api/v1/backup/:id` - full integrity/manifest detail for one backup.
- `POST /api/v1/backup/:id/restore` - the destructive restore, requires
  `{"confirmed": true}` in the request body or is refused outright.

There is no scheduling/retention admin screen yet - `applyRetentionPolicy()`
exists and is tested but is not yet wired to a recurring job; run backups
on a cron/scheduled task pointed at `POST /api/v1/backup` until it is.

What a backup includes: a `pg_dump` of the database (custom format), the
uploaded-files directory, and a `manifest.json` recording Core version,
every installed app's version, and SHA-256 checksums of both the database
dump and the files archive. Consistency guarantee (read this before
relying on it): the database portion is one consistent MVCC snapshot via a
single `pg_dump` run; uploaded files are immutable once stored in this
codebase, so files are captured correctly even though they are not part of
the same transaction as the database snapshot - see the service's own doc
comment for the precise wording. **[VERIFICATION PENDING]**: the actual
`pg_dump`/`pg_restore` execution has not been run in the sandbox this was
built in (those binaries are not installed there) - every other part
(manifest, checksums, tamper detection, retention, compatibility,
destructive-restore guard) is tested against a real filesystem and real
Postgres with an injected fake dump/restore step. See
`P3-ENVIRONMENT-VERIFICATION.md`.

## 6. Restore

`restoreBackup()` refuses to run without explicit confirmation, refuses a
backup that fails integrity verification, refuses a backup from a newer
Core major version than what's running, and performs a full-replace (not
merge) restore of both database and files. **[VERIFICATION PENDING]**,
same reason as §5.

## 7. Updates

`Administration -> System -> Updates` (`apps/api/src/platform/update/update.controller.ts`):

- `POST /api/v1/update/check` - point at a locally-placed offline update
  package + its signed manifest (`{packagePath, manifest}`); verifies
  authenticity, compatibility, and disk space WITHOUT applying anything,
  returning `readyToApply`.
- `POST /api/v1/update/apply` - the real sequence, requires
  `{"confirmed": true}`: verify package authenticity+integrity -> check
  version compatibility (no downgrades via this path - restore a
  pre-update backup instead) -> disk space preflight -> backup preflight
  (auto-backing-up unless `requireBackup: false` is passed) -> enter
  maintenance mode -> run REAL database migrations -> REAL post-update
  health check -> exit maintenance mode. A migration or health-check
  failure correctly leaves the installation IN maintenance mode rather
  than exiting into a possibly broken state - restore a pre-update backup
  to recover. No internet connection is required anywhere in this flow.

**Maintenance mode caveat, stated plainly**: `apply` sets and clears a
real, queryable flag (`installations.config.maintenanceMode`), but no
request-blocking middleware in this codebase currently rejects ordinary
traffic while it is set - the flag exists for a reverse proxy or future
middleware to act on, but does not yet itself stop traffic. Tracked as
follow-up, not silently assumed complete.

## 8. Licence administration

`Administration -> Applications -> <app> -> Licence`
(`GET/POST /api/v1/apps/:appId/licence`). Reports, independently:
`licenceValid`, `licensedMajorVersion`, `licenceId`, `organisationId`,
`installedVersion`, `compatible`, `supportExpiresAt`, `supportExpired`.
**Support expiry never stops the application working** - a perpetual
licence with expired support continues to show `active: true`; this is
tested explicitly (`licence-admin-http.integration.spec.ts`). Importing a
licence requires the `core.users.manage`-equivalent admin permission
(`core.organisation.manage`) and never requires internet access.

## 9. MFA / admin-assisted reset

Self-service TOTP enrolment plus recovery codes (`docs` - see P0's MFA
enrolment flow). Lost-device-and-recovery-codes recovery:
`POST /api/v1/auth/users/:id/mfa/reset`, gated by a SEPARATE elevated
permission (`core.users.mfa_reset`, distinct from general user
management), always audited, always revokes the target's active sessions,
and an admin cannot reset their own MFA through this endpoint (use
self-service re-enrolment or a recovery code instead).

## 10. Service accounts / API keys

See `docs/APP_SDK.md` and the Public REST API section of
`docs/decisions/P2-DEVIATIONS.md` ("every existing `@RequirePermission`-
guarded route is already a public API route for a suitably-scoped service
account").

## 11. Logs

See `docs/LOGGING.md` in full. Summary: structured JSON to stdout; no
in-process log file, rotation/retention delegated to your Docker logging
driver / journald / supervisor+logrotate. Every error response includes a
`referenceId` you can grep your stdout capture for.

## 12. Diagnostics / health

`Administration -> System -> Health` / `Diagnostics`
(`GET /api/v1/system/health`, `GET /api/v1/system/diagnostics`) - real
checks (database connectivity, migration count, disk space, background
job failures, SMTP status, per-app compatibility/licence, webhook/
integration failures), each with an actionable `status`/`detail`, never a
bare boolean. No secrets are ever included in either response.

## 13. Support bundles

`Administration -> System -> Support Bundle`
(`GET /api/v1/support-bundle/preview` to see categories before generating,
`POST /api/v1/support-bundle` to generate). Explicitly admin-initiated,
previewable before generation, never auto-uploaded - the response is
returned directly to the requesting admin, nothing in this codebase makes
an outbound call with it. Two independent redaction layers (key-based +
free-text scrubbing) - see the module's own
extensive canary-secret test suite for what's proven never to leak.

## 14. Troubleshooting

- **"Missing or invalid CSRF token" when re-submitting login while already
  logged in**: fixed (ADR 0007) - if you see this, you are running a
  version older than this fix.
- **A background job or webhook is stuck failing**: check
  `GET /api/v1/system/health`'s `backgroundJobs`/`webhookDeliveryFailures`
  counts, then generate a support bundle for the detailed (redacted)
  failure summary.
- **SMTP test email fails**: the error message from
  `POST /api/v1/smtp/test` is the actual SMTP server's rejection reason
  (e.g. `535 5.7.8 Authentication failed`) - `smtp-client.ts` surfaces the
  real protocol-level error, not a generic failure.
- **An admin forgot their password and has no other admin**: not yet a
  documented recovery path in this guide - tracked as follow-up
  (disaster-recovery documentation, §16).

## 15. Uninstall / data retention

For a Docker deployment (`docker-compose.prod.yml`): run
`scripts/uninstall-docker.sh` (optionally `--env-file <path>` if your
`.env` isn't at the repo root). It is interactive and destructive by
design, not silent:

1. Reminds you to take a final backup and/or a Data Portability export
   first (see §16).
2. Stops and removes the containers (`docker compose down`) - your data
   volumes (`hexyrn_pg_data`, `hexyrn_storage`, `hexyrn_backups`,
   `hexyrn_caddy_data`, `hexyrn_caddy_config`) are explicitly NOT touched
   by this step; re-running `docker compose up` afterward restores the
   installation exactly as it was.
3. Only if you explicitly confirm a SECOND time, permanently deletes
   those data volumes too (`docker compose down -v`).

Built Docker images are deliberately left in place either way - remove
them separately (`docker image prune` / `docker rmi`) if you also want
the disk space back. Genuinely tested end to end (both the "keep data"
and "delete data" paths) during P3 development, not just reviewed.

A native (non-Docker) install and the Windows installer's own uninstall
path are separate, not yet implemented - see the Windows installer
section (§3) and P3-ENVIRONMENT-VERIFICATION.md.

## 16. Data export / disaster recovery

Data export: see Core's Data Portability service
(`apps/api/src/platform/exports/data-portability.service.ts`, P2 item 22)
for CSV export of any dataset a user has view permission on - does not
require an active support entitlement, only the underlying view
permission, matching "Open by Design." A dedicated disaster-recovery
runbook (beyond §5/§6's backup/restore mechanism itself) is not yet
written.

## 17. Known documentation gaps (stated plainly, not hidden)

- Backup/restore/update/support-bundle now have HTTP admin endpoints
  (§5-7, §13), but no dedicated frontend admin SCREEN yet (they are
  callable API endpoints, not yet buttons in the web UI) - no scheduling/
  retention admin screen for backups, and maintenance mode is a real flag
  that no middleware enforces yet (§7).
- No concrete reverse-proxy config examples (nginx/Caddy/Traefik).
- No uninstall/disaster-recovery runbook.
- Windows installation section is a placeholder pending the installer
  itself.
