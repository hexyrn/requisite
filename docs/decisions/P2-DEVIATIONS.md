# P2 Deviations from Architecture v1.0

No architecture contradictions were found during P2 implementation - every
item in the P2 brief was buildable within Architecture v1.0 as written,
generally by reusing an existing P0/P1 mechanism (permission evaluator,
event outbox + dispatch_queue routing pattern, scheduling engine, storage-
provider-style DI seams) rather than inventing a parallel one. This file
records the same kind of thing `P0-DEVIATIONS.md`/`P1-DEVIATIONS.md` do.

## Named, documented simplifications (each has its own ADR or inline doc comment)

- **Real Ed25519 license verification** - `docs/decisions/0006-real-license-verification.md`.
  Resolves ADR 0004's P1 stub. The committed TEST keypair
  (`apps/api/src/platform/licensing/keys.ts`) is unmistakably labeled and
  logs a loud structured warning every time it's used as a fallback -
  production MUST set `HEXYRN_LICENSE_PUBLIC_KEY`.
- **`api_credential_lookup` routing table** (migration 0032) - the same
  kind of genuinely new mechanism ADR 0005 introduced for cross-org
  background work discovery, applied to API-key authentication: resolving
  "which organisation does this key prefix belong to" cannot happen inside
  `withOrgContext` (we don't have an org yet), so a small NO-RLS pointer
  table (prefix -> organisation_id/credential_id only, no secret material)
  exists purely for that first lookup step; the actual secret/revoked/
  enabled verification still happens inside a real `withOrgContext` for
  that organisation.
- **Secret-at-rest encryption reuses the P0/ADR-0002 simplified scheme**
  (`security/secret-encryption.ts`): a single AES-256-GCM master key from
  an env var, not full envelope encryption with per-secret data keys. Used
  for webhook signing keys and integration connection secrets. Same
  accepted rotation limitation as TOTP secrets (ADR 0002): rotating the
  master key invalidates every stored secret of that kind and requires
  re-issuing them. `SECRET_ENCRYPTION_MASTER_KEY` is a SEPARATE env var
  from `TOTP_MASTER_KEY` specifically so rotating one doesn't force
  re-enrolling the other, but it falls back to `TOTP_MASTER_KEY` if unset
  (dev/test convenience) - production should set both distinctly.

## Explicitly narrower than a full commercial implementation

- **Sync Engine (item 20)** applies external records to Hexyrn tables via
  an app-registered `SyncRowHandler` (a distinct contract from the Import
  Framework's `ImportRowHandler` - it returns the Hexyrn entity id so
  `sync_external_ids` dedup can be maintained). It does NOT implement the
  `hexyrn_to_external` or `bidirectional` sync directions - `sync_ownership`
  can declare them and `field_mappings`/`conflict_resolution` are validated
  at configuration time, but `SyncEngineService.runSync()` only actually
  executes `external_to_hexyrn`. Outbound/bidirectional sync execution is
  real, non-trivial additional work (conflict detection, outbound API
  calls per connector) intentionally left for a dedicated post-P2 pass -
  the schema and configuration surface are ready for it.
- **Data Portability (item 22)** bundles CSV only, one buffer per dataset,
  returned in memory - not a single downloadable archive file (no zip
  library was added to avoid an unreviewed new dependency this late in the
  phase) and not yet wired to a background job for a very large
  organisation (it reuses `ExportService`'s synchronous path and its
  `MAX_SYNCHRONOUS_ROWS` cap per dataset).
- **Query timeout (item 25)** is a single fixed 10s `SET LOCAL
  statement_timeout`, not per-role/per-plan configurable.
- **Webhook delivery (item 14)** does not yet implement exponential
  backoff between retry attempts - a failed delivery is retried on the
  next `dispatchPending()` pass with no enforced delay, same as the P1
  event dispatcher's own retry behaviour it deliberately mirrors.
- **Integration Centre (item 17)** exists as the `ConnectorRegistryService`
  catalogue + `IntegrationConnectionService` configuration API; no
  dedicated admin HTTP controller/UI was built in P2 (same "no HTTP
  surface yet, boot-time/service-level only" pattern P1 used for capability
  registration - see P1-DEVIATIONS.md's closing note, which applies
  identically here).

## Not a deviation, but worth stating explicitly

**The Public REST API (item 11) is not a separate controller layer.**
`SessionAuthGuard` was extended to accept EITHER a session cookie OR a
service-account `Authorization: Bearer hxk_...` key, populating
`request.permissionSubject` identically either way - so every existing
`@RequirePermission`-guarded route is already a "public API" route for a
suitably-scoped service account, with no second authorisation universe and
no separate route tree to keep in sync. This is deliberate: Architecture's
"no second authorisation universe" principle (already applied to workflow/
approval/report-query permission checks in P1/P2) extends naturally to
authentication itself.
