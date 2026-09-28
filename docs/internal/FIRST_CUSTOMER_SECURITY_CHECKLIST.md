# First-customer security checklist (P3 item 22)

Repeatable, per-deployment. Every item below has a concrete way to check
it - not a vague aspiration.

- [ ] **HTTPS**: the customer-facing URL is `https://`, not `http://`.
- [ ] **Secure cookies**: `COOKIE_SECURE=true` set (verify: the `Set-Cookie` header on login includes `Secure`).
- [ ] **Trusted proxy**: `TRUSTED_PROXY_CIDRS` set to the actual reverse proxy's address only - not `0.0.0.0/0`, not unset.
- [ ] **Firewall**: PostgreSQL's port is NOT exposed to the public internet - only reachable from the application server itself.
- [ ] **Runtime DB role**: the application connects as the restricted role (`hexyrn_app` in the Docker model), not the migration/owner role. Verify: `GET /api/v1/system/diagnostics` or a direct query confirms non-superuser, non-BYPASSRLS (`db-role-security.integration.spec.ts`'s check, run manually against the production database).
- [ ] **Backups configured**: `HEXYRN_BACKUP_DIR` set, a real `POST /api/v1/backup` has succeeded (`GET /api/v1/backup` shows `valid: true`).
- [ ] **Backup destination is off-machine**: not the same disk as the primary database (Architecture's explicit off-site warning intent).
- [ ] **MFA for admins**: every account holding `core.organisation.manage` or higher has MFA enrolled.
- [ ] **Bootstrap disabled**: confirm re-running bootstrap is refused (the one-time token is already consumed).
- [ ] **No demo data**: confirm no reference-app or sample Requisite data exists in the production organisation.
- [ ] **No development keys**: `HEXYRN_LICENSE_PUBLIC_KEY` and `HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS` are both explicitly set to Hexyrn's real production public keys - NOT relying on the committed dev/test fallback (check server logs for the `licensing.using_test_public_key` / `release_signing.using_test_public_keys` warnings - their ABSENCE confirms real keys are configured).
- [ ] **Production licence trust**: the imported Requisite licence verifies against the production public key, not the test key.
- [ ] **Production release trust**: if/when offline updates are used, `HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS` is the real production trust set.
- [ ] **SMTP**: configured and a real test email confirmed delivered (or explicitly, deliberately skipped with the customer's informed agreement to share links manually).
- [ ] **Outbound webhook/integration policy**: `HEXYRN_OUTBOUND_ALLOWED_HOSTS` reviewed - only genuinely-needed internal destinations listed, nothing overly broad.
- [ ] **Logs**: the deployment's log capture (Docker logging driver / journald / supervisor) is actually configured, not defaulting to nothing (`docs/LOGGING.md`).
- [ ] **Support bundle**: a test generation (`POST /api/v1/support-bundle`) succeeds and, on inspection, contains no secrets (this is continuously tested by the codebase's own canary tests, but a one-time manual spot-check on the real production instance is good practice).
- [ ] **Update procedure understood**: the customer/operator knows offline updates go through `POST /api/v1/update/check` then `/apply`, require a pre-update backup, and that a failed update leaves the system in maintenance mode pending manual recovery (`docs/DISASTER_RECOVERY.md` §6).
