# Release Notes

Format established here (P3 item 44): version, release date, supported
Core/app version pairing, new features, fixes, security fixes (where
disclosure is appropriate), migration notes, known issues, support
information. Every future release follows this same shape.

---

## Hexyrn Core 1.0.0-rc1 (release candidate, not yet GA)

**Status: RELEASE CANDIDATE - not production-final.** See the P3
completion report for the exact evidence behind this status and what
remains before general availability.

**Supported pairing**: Hexyrn Requisite 1.0.0-rc1 requires Hexyrn Core
`>=1.0.0-rc1`.

### New in this release (P0-P3 cumulative - first release)

- Full Core platform: organisations, people/users, RBAC, sessions, MFA
  (TOTP + recovery codes + administrator-assisted reset), audit framework,
  RLS-enforced multi-tenancy, App Registry with capability discovery,
  custom fields, forms, numbering, declarative workflow/approval engine,
  notifications, secure file storage, reporting/dashboards/exports,
  platform search, public REST API with scoped service accounts, signed
  webhooks, external integration framework, offline-verifiable perpetual
  application licensing.
- Production-readiness hardening (P3): database role/RLS security
  verification, production configuration fail-fast startup checks, TOTP
  envelope encryption with master-key rotation, real backup/restore
  mechanism, offline update system, release-manifest signing with key
  rotation, SSRF-hardened outbound webhook delivery, administrator support
  bundles with aggressive secret-leakage testing, SMTP administration with
  a real test-email function, licence administration UX, system health/
  diagnostics, a global exception filter (no raw error leakage, reference
  IDs for support), and a defined release-candidate CI pipeline.

### Security fixes

- **CSRF check incorrectly applied to public routes with an existing
  session cookie** (ADR 0007) - an already-authenticated user re-visiting
  `/login` received a confusing, incorrect CSRF error. Fixed; no
  weakening of CSRF protection for any genuinely authenticated route
  (regression-tested).
- **Docker deployment path connected to Postgres as a superuser** -
  silently defeated Row-Level Security for any self-hosted Docker
  deployment even though every RLS test passed (a superuser bypasses
  `FORCE ROW LEVEL SECURITY`). Fixed with a two-role split (`docs/internal/DOCKER_ROLE_MODEL.md`);
  native/manual Postgres installs were unaffected.
- **Webhook delivery had no SSRF protection** - would fetch any
  admin-configured URL including localhost, private network ranges, and
  the cloud metadata service address. Fixed with an explicit,
  administrator-controlled outbound network policy (`docs/SSRF_POLICY.md`).
- **TOTP secrets used direct single-key encryption, not envelope
  encryption** (ADR 0002/0008) - master-key rotation was destructive
  (forced MFA re-enrolment for every user). Fixed with real envelope
  encryption and tested rotation.

### Migration notes

First release - no upgrade path from an earlier version exists yet.
Forward-only migrations from this point (Architecture's stated policy);
rollback is via pre-update backup + restore, never an in-place schema
rollback.

### Known issues

- No Windows installer yet (P3 item 3 not built).
- Docker production compose (app container + reverse-proxy example) not
  yet written; `docker compose up` itself not verified in the environment
  this release was prepared in (no Docker daemon available there).
- Real `pg_dump`/`pg_restore` execution not verified in that same
  environment (binaries not installed there) - the backup/restore
  orchestration is fully implemented and tested with an injected fake
  dump/restore step.
- No Administration UI yet for backup/restore/update/support-bundle (the
  backend services are complete and tested; only SMTP/licence/health have
  HTTP surfaces so far).
- See `P3-ENVIRONMENT-VERIFICATION.md` for the complete, explicit list of
  what could not be verified in this sandboxed environment and exactly
  what's needed to close each item.

### Support information

Licensed major version 1 has a perpetual right to use per the signed
licence file; support/security-fix entitlement is tracked separately
(`supportExpiresAt`) and never gates runtime functionality - see
`docs/internal/OPERATOR_GUIDE.md` §8.

---

## Hexyrn Requisite 1.0.0-rc1 (release candidate, not yet GA)

**Requires**: Hexyrn Core `>=1.0.0-rc1`.

### New in this release (first release)

Full purchasing lifecycle: Supplier -> Requisition -> (optional RFQ/Quote
comparison) -> Purchase Order -> Goods Receipt, with complete
traceability. Approval workflow with self-approval blocked server-side.
Real multipart file attachments. Customer-facing React UI covering every
screen in the lifecycle, responsive to tablet width, keyboard-accessible
throughout (see `docs/REQUISITE_USER_GUIDE.md`'s Accessibility section for
what was manually verified and the two real issues found and fixed during
that pass). Generic Core report interface exposes Requisite's registered
reports with no separate reporting engine.

### Known issues

Same environment-verification caveats as Core 1.0.0-rc1 apply to any
Requisite functionality that depends on them (backup/restore of
Requisite's own data goes through Core's backup mechanism).
