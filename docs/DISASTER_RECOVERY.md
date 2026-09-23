# Disaster recovery procedures (P3 item 20)

Precise, scenario-by-scenario. Where a scenario is untestable without a
real target environment, that's stated explicitly - see
`P3-ENVIRONMENT-VERIFICATION.md`.

## 1. Server lost, backup available

1. Provision a new server matching §1 of `docs/OPERATOR_GUIDE.md`'s
   system requirements.
2. Install Hexyrn Core fresh (do NOT bootstrap - restoring will populate
   the database, and re-bootstrapping first would create a conflicting
   installation row).
3. Copy the backup directory (manifest.json + database.dump + files/)
   to the new server.
4. Run migrations (`npm run migrate`) to bring the empty database to the
   current schema version.
5. Restore: `POST /api/v1/backup/:id/restore` with `{"confirmed": true}`
   (or the eventual CLI/admin-UI equivalent).
6. Verify: log in, confirm Requisite data and licence state are present,
   run `GET /api/v1/system/health`.

**Critical secrets that must ALSO be backed up separately from the
database backup** (the backup mechanism backs up DATA, not installation
secrets - see §5 below) - without these, encrypted data in the restored
database is permanently unrecoverable even though the backup itself
succeeded:
- `TOTP_MASTER_KEY_CURRENT` (and `_PREVIOUS` if mid-rotation) - loses
  this, every user's MFA is permanently unusable via the normal path
  (admin-assisted reset still works, since it doesn't need to decrypt the
  old secret - it clears and requires re-enrolment).
- `SECRET_ENCRYPTION_MASTER_KEY` - loses this, every stored webhook
  signing key and integration credential becomes permanently undecryptable
  and must be re-entered by re-configuring each webhook/integration.
- `HEXYRN_LICENSE_PUBLIC_KEY` / `HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS` - not
  secrets (public keys), but losing your customisation of these reverts
  verification to the committed dev/test keys with a loud warning - not
  data-loss, but a security-configuration regression to fix.

**State this explicitly to every customer**: these are environment
variables, not database rows - your own backup/configuration-management
process (not Hexyrn's database backup) must separately preserve `.env` (or
equivalent secret storage) alongside the database backup. Losing these
keys with no separate record of them makes the corresponding encrypted
data permanently, cryptographically unrecoverable - there is no "forgot
password" recovery path for a lost master key, by design (that's what
makes it real encryption).

## 2. Database corrupted (server intact)

Same as §1 from step 4 onward (migrate a fresh database, restore). If
Postgres itself is corrupted (not just Hexyrn's data), first restore
Postgres to a working state using standard PostgreSQL recovery procedures
(this is a PostgreSQL operational concern, out of Hexyrn's scope), THEN
proceed with the restore above into the freshly-working Postgres instance.

## 3. Uploaded-file storage lost, database intact

The restore flow (`restoreBackup()`) always restores BOTH database and
files together from the same backup - there is no "files-only restore"
today. If only files were lost (e.g. a separate disk failure) and the
database is fine, restoring the whole backup would roll back database
rows too. Until a files-only restore path exists (tracked as follow-up),
manually copy `files/` from the most recent backup's `destinationDir`
into `LOCAL_STORAGE_PATH` - this recovers files up to the backup's
timestamp; any files uploaded after that backup and before the loss are
gone (this is the same recency limit backups always have).

## 4. Application binaries/installation lost, data intact

Reinstall Hexyrn Core fresh (Docker: recreate the container from the same
image; Windows: reinstall via the installer once it exists) pointed at
the EXISTING database and file storage - do not run bootstrap (the
organisation/owner already exist in the surviving database) and do not
run migrations if the schema is already current for that Core version.

## 5. Encryption key / configuration lost, data intact

As stated in §1: this is the one scenario database backups do NOT
protect against. If `TOTP_MASTER_KEY_CURRENT`/`_PREVIOUS` are lost with
no separate record, every enrolled user's MFA becomes unusable through
the normal challenge path - use administrator-assisted MFA reset
(`POST /api/v1/auth/users/:id/mfa/reset`) for each affected user, which
does not require decrypting the old secret. If `SECRET_ENCRYPTION_MASTER_KEY`
is lost, every webhook/integration credential must be re-entered by an
admin (there is no way to recover the plaintext).

## 6. Update failed

`applyUpdate()` never exits maintenance mode after a migration or
health-check failure (proven by `update.service.spec.ts`'s explicit
tests) - the installation is left safely in maintenance mode, rejecting
ordinary traffic (P3 item 4's enforcement), rather than serving a broken
state. Recovery: restore the pre-update backup (auto-created by the
update flow unless explicitly skipped) via §1/§2 above, onto the previous
Core version's binaries.

## 7. Licence file lost

Not a data-loss scenario for the customer's Requisite data - Requisite
continues to be licensed as long as `application_licenses` (a database
row, included in every backup) is intact. If BOTH the original licence
file AND the database row are lost (e.g. total data loss with no backup
at all - see §1), contact Hexyrn support to have the licence file
re-issued; the licence itself (a signed statement of entitlement) is not
consumed or invalidated by being "lost" on the customer's end, since
verification is offline against Hexyrn's public key, not a call-home
activation count.
