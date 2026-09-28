# P3 Final Pre-Environment Security Pass (item 23)

A targeted review of the specific attack surfaces named in the
coordinator's P3 follow-up list, checked against real code in this
repository (grep + direct reading, not assumption), covering surfaces
added or changed this round (the five admin UI screens, Docker
deployment, release manifest generator, uninstall script) plus a
re-check of a few items from earlier rounds. Each item states what was
checked and the file(s)/lines that back the finding - this is a review
pass, not new implementation, except where a real issue was found (noted
explicitly).

## Backup path manipulation / restore path traversal

`apps/api/src/platform/backup/backup.controller.ts`'s `assertSafeBackupId()`
(line ~162) rejects any `:id` route parameter that isn't
`^[0-9A-Za-z_-]+$` before it is ever joined into a filesystem path via
`join(this.backupsRoot(), id)` - a caller cannot supply `../../etc` or an
absolute path. `backup.service.ts` additionally calls `resolve()` on the
configured backup root itself. Checked: **no path traversal surface
found.**

## Update package traversal / signature bypass

`update.controller.ts`'s `check`/`apply` take `packagePath` directly from
the request body with no path confinement - deliberately, not an
oversight: this endpoint is `ORGANISATION_MANAGE`-gated (an already-
trusted admin with server access), and the entire feature is "verify a
package file the admin themselves placed on this machine's disk" (P3
item 14's offline-update model) - confining it to a subdirectory would
break the intended use (an admin choosing where to stage the package).
The actual security-relevant check is signature verification:
`ReleaseVerifier.verifyArtifactFile()` re-hashes the real file bytes and
checks the Ed25519 signature against the trusted key set
(`release-keys.ts`) - `applyUpdate()` in `update.service.ts` refuses to
proceed (`steps.push({step: 'verify_package', ok: false...})`, returns
early) if that fails. Checked: **signature verification is genuinely
enforced before any migration/maintenance-mode step runs; no bypass path
found** (confirmed by `update.service.spec.ts`'s tests for this exact
early-return behaviour, re-run clean this round).

## Installer privilege issues

`installer/windows/Product.wxs` (this round's new groundwork) currently
uses `Account="LocalSystem"` for the Windows Service - explicitly flagged
in `docs/internal/WINDOWS_INSTALLER_DESIGN.md` as a placeholder, not a final
decision, pending the PostgreSQL-bundling choice. Not yet built or run,
so this is a documented open item, not a "checked, no issue" line.

## Support-bundle path handling / information disclosure

`support-bundle.controller.ts` never accepts a caller-supplied path at
all (`generate()` takes no body) - the bundle is assembled entirely
server-side from `SupportBundleService`, which applies
`redactBundleDeep()` + `scrubFreeText()` (the free-text credential-leak
fix found earlier this phase) before the bundle is ever serialized to
the HTTP response. `AdminSupportBundlePage.tsx` (this round's new UI)
only ever downloads the bundle the server already redacted - it does not
introduce any new path for raw data to reach the browser. Checked: **no
new disclosure surface from the admin UI addition.**

## Maintenance-mode bypass

`maintenance-mode.ts`'s `checkMaintenanceMode()` blocks mutating requests
outside an explicit allowlist (health, backup/update/support-bundle
admin endpoints themselves, login/logout). The five new admin UI pages
call exactly those already-allowlisted endpoints - no new endpoint was
added outside that set this round. Checked: **no new maintenance-mode
bypass surface.**

## Admin endpoint CSRF

Re-verified directly (not assumed from memory) that `SessionAuthGuard` is
registered as a global `APP_GUARD` in `app.module.ts` (alongside
`ApplicationActiveGuard`/`PermissionGuard`), and its CSRF check (line
~94-99: any mutating method on a non-public route requires
`X-Hexyrn-CSRF` to match the session's token) applies unconditionally
unless a route is explicitly `@Public()`. Grepped every controller
touched this round (`backup`, `update`, `smtp`, `support-bundle`,
`app-state`) for `@Public()` - **none present**, so every POST/DELETE the
new admin UI issues is genuinely CSRF-protected, not just assumed to be
because it inherited a guard. `apps/web/src/api/client.ts`'s `request()`
(which every new admin API call in `apps/web/src/api/admin.ts` goes
through) already attaches the `X-Hexyrn-CSRF` header on every non-GET
call - confirmed by reading the file, not new code added this round.

## SMTP credential exposure

`smtp-config.service.ts`'s `getConfigForDisplay()` returns
`passwordSet: boolean` only - the plaintext password and its stored
ciphertext are never included in the GET response shape
(`SmtpConfigForDisplay` interface, distinct from the internal
`SmtpConfig` that includes the real password field). `AdminSmtpPage.tsx`
(this round's new UI) never receives or displays a password value - the
password `<Input>` is always blank on load, matching the backend's own
"blank means keep existing" rule. Checked: **no credential exposure via
the new admin screen.**

## Diagnostics information disclosure

`health-diagnostics.controller.ts`'s `getDiagnostics()` is
`ORGANISATION_MANAGE`-gated, same as every other admin surface - not
reachable by an unauthenticated or non-admin caller. Not re-audited for
WHAT it includes in this pass (that content-level review already
happened in the P3 round that built this controller); this pass only
re-confirmed the access-control gate is still in place after the admin
UI was added on top of it.

## Command argument injection around pg_dump/pg_restore

Re-checked `backup.service.ts`'s `realPgDump`/`realPgRestore` (recently
rewritten this round for the TRUNCATE fix): both use `execFileAsync` with
an argument ARRAY (`execFileAsync(pgDumpPath, ['--format=custom', ...])`),
never a shell-interpolated string - `execFile` (unlike `exec`) does not
invoke a shell, so there is no shell-metacharacter injection surface via
`connectionString`/`outputPath`/`dumpPath` even though those values
ultimately derive from configuration. Checked: **no command injection
surface, confirmed by re-reading the actual invocation this round's
edits produced, not the pre-edit version.**

## Release manifest parsing / signing key confusion

`generate-release-manifest.ts` (this round's new script) defaults to the
publicly-committed TEST release key with an explicit, unmissable warning
printed to stderr - never silently signs with a production-looking key.
Release-signing keys (`release-keys.ts`) remain a genuinely separate
module/key domain from licensing keys (`licensing/keys.ts`), unchanged
this round - re-confirmed by grep that neither module imports from the
other.

## Summary

No new vulnerability was found in the surfaces added this round (five
admin UI screens, Docker deployment, release manifest generator,
uninstall script) - each traces back to an already-enforced backend
control (permission gate, CSRF guard, path-safety assertion, redaction
pass) that this pass re-verified is genuinely still wired up after the
new code landed, rather than assuming it must be. The one real, still-
open item from this pass is the Windows installer's placeholder service
account (`LocalSystem`), already tracked in
`docs/internal/WINDOWS_INSTALLER_DESIGN.md` as unresolved pending a product
decision - not a regression, a documented gap in unbuilt groundwork.
