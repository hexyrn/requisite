# Hexyrn Core Architecture v1.0 — APPROVED FOR IMPLEMENTATION

Status: **FROZEN.** This is the approved architecture for Hexyrn Core v1. The decisions listed in "Frozen Decisions" below are not to be reopened during implementation unless implementation reveals a genuine contradiction, security issue, or materially better solution — in which case: stop, document the issue, and seek review before changing the architecture. This document supersedes Revisions 1 and 2 in full.

---

## 1. Scoped Authorisation

**Decision: no `role_scope_conditions` table in v1.** Scoping is deferred as a *designed extension point*, not a placeholder schema.

**v1 model (unchanged):** `permissions` are flat strings (`requisite.requisitions.approve`). `roles` grant permissions organisation-wide. `PermissionGuard` checks "does this user hold this permission," full stop.

**Why no premature table:** a scope table designed before any app has real scoping requirements risks encoding the wrong shape (e.g. assuming single-dimension org-unit scoping when real needs turn out to be "org unit AND value ceiling combined"). Building it now would be exactly the kind of speculative abstraction the engineering principles reject.

**The extension point is architectural, not schematic:**

- Every permission check goes through one seam: `PermissionEvaluator.check(user, permission, context?)`. `context` is an optional, permission-specific object (e.g. `{ organisationalUnitId, amount }`) that callers (app controllers/services) already have at hand when checking approval-type permissions — they pass it whether or not it's used.
- In v1, `PermissionEvaluator` ignores `context` and does the flat role/permission check described above. No app code changes when scoping is later introduced, because the call signature already carries context.
- When scope requirements are properly gathered (after real usage from Requisite's approval rules, most likely), we design a dedicated scope model — plausibly a small rules table per (role, permission) → list of `(conditionType, operator, value)` tuples, e.g. `organisationalUnitId IN (...)`, `amount <= 5000`, combined with AND/OR — and swap the evaluator's internals to consult it. Because the seam is already the only place permission logic runs, this is an internal change to `PermissionEvaluator`, not a rewrite of every controller.
- Reporting/search/export scoping (§11 in Rev 1) goes through the same evaluator, so scoped conditions automatically apply to aggregates once introduced — the "Manchester totals" leak concern stays closed under the future model, not just the flat one.

**Path to the examples given:**
- *Org-unit-limited access* → context carries the target record's `organisationalUnitId`; future evaluator checks it against the role's granted unit set (which may include "and descendants").
- *Location-limited access* → same pattern with `locationId`.
- *Approval ceiling* → context carries `amount`; future evaluator checks it against a per-role/permission ceiling.
- *Combinations* → the future rule row supports multiple condition clauses ANDed together; this is a detail of the scope model's internal design, not something the calling code needs to know about, because callers only ever pass raw context and get a boolean back.

This is deferred correctly: nothing in v1 forecloses it, and nothing in v1 guesses at its shape.

---

## 2. Custom-Field Storage (Revised per approval feedback — generated-column pool REJECTED)

**Change from Revision 2:** the pooled generated-column mechanism is dropped. It does not cleanly solve organisation-specific dynamic fields, because a generated column's expression is fixed schema (`values->>'warranty_status'`) — it cannot mean a different JSON key per organisation without either one shadow column per org (unworkable) or a shared key namespace across orgs (defeats the point of per-tenant custom fields). Below is the corrected design.

### 2.1 Schema

```sql
-- Definition (metadata) — one row per field per entity type, per org
CREATE TABLE custom_field_definitions (
  id UUID PRIMARY KEY,
  organisation_id UUID NOT NULL,
  app_id TEXT NOT NULL,              -- 'com.hexyrn.assets'
  entity_type TEXT NOT NULL,         -- 'asset'
  key TEXT NOT NULL,                 -- stable identifier, e.g. 'warranty_status'
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,          -- 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'select' | 'multiselect' | 'person' | 'org_unit' | 'location' | 'reference' | 'url' | 'email' | 'phone'
  is_filterable BOOLEAN NOT NULL DEFAULT false,
  is_sortable BOOLEAN NOT NULL DEFAULT false,
  is_reportable BOOLEAN NOT NULL DEFAULT false,
  classification TEXT NOT NULL DEFAULT 'internal', -- §38 tie-in
  select_options JSONB,              -- for select/multiselect
  validation JSONB,
  ordering INT,
  UNIQUE (organisation_id, app_id, entity_type, key)
);

-- Values — one JSONB row per entity record (not per field)
CREATE TABLE custom_field_values (
  organisation_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  values JSONB NOT NULL DEFAULT '{}',   -- { "warranty_status": "active", "purchase_cost": 1250.00, ... }
  PRIMARY KEY (organisation_id, entity_type, entity_id)
);

-- General-purpose JSONB index, supports containment/existence queries across all custom fields at once
CREATE INDEX ix_cfv_values_gin ON custom_field_values USING GIN (values jsonb_path_ops);
```

### 2.2 Storage abstraction — the query layer never touches raw JSONB syntax

**All custom-field access — filtering, sorting, grouping, aggregating — goes through one seam:**

```ts
interface CustomFieldQueryProvider {
  expression(fieldDefinition: CustomFieldDefinition): SqlExpression;   // typed, castable reference to this field's value
  filterCondition(fieldDefinition, operator, value): SqlCondition;
  sortExpression(fieldDefinition, direction): SqlExpression;
  groupExpression(fieldDefinition): SqlExpression;
}
```

Callers — the report engine, the entity list/filter API, the search indexer — request `CustomFieldQueryProvider.expression(fieldDefinition)` and get back a query-builder fragment; they never write `values->>'field_name'` themselves and never know whether that fragment resolves to a JSONB path expression, an expression index, or (later) something else entirely. The v1 implementation of this interface produces type-aware JSONB path expressions:

```ts
// CustomFieldQueryProvider implementation, v1
expression(def) {
  const path = `values->>'${def.key}'`;                 // text extraction
  switch (def.fieldType) {
    case 'integer':  return sql`((${raw(path)})::integer)`;
    case 'decimal':  return sql`((${raw(path)})::numeric)`;
    case 'boolean':  return sql`((${raw(path)})::boolean)`;
    case 'date':     return sql`((${raw(path)})::date)`;
    case 'datetime': return sql`((${raw(path)})::timestamptz)`;
    default:         return sql`${raw(path)}`;            // text/select/reference stay text
  }
}
```

This is the mechanism the review asked for: physical storage strategy (JSONB path today, an expression index or a different representation tomorrow) is entirely behind `CustomFieldQueryProvider`, so evolving it later changes one implementation, not every report definition or app query that references a custom field.

**Type-aware query generation** relies on `custom_field_definitions.field_type`, not on inspecting the JSONB value at runtime — a `decimal` field's expression always casts to `numeric`, regardless of what happens to be stored, so sort/filter/sum behave correctly and consistently.

**Expression indexes for specific fields:** when a field is marked `is_filterable`/`is_sortable`/`is_reportable` and is known to be queried heavily, an administrator (or, in v1, a documented manual DBA step / a Core-provided CLI helper `hexyrn custom-field index <field-id>`) can add a targeted Postgres expression index built from the exact same expression `CustomFieldQueryProvider` already generates:

```sql
CREATE INDEX ix_asset_warranty_status
  ON custom_field_values ((values->>'warranty_status'))
  WHERE organisation_id = '...' AND entity_type = 'asset';
```

Because the index expression and the query-generation expression are generated from the same field-type-driven logic, they stay in sync by construction — there is no separate "shadow column" concept to keep consistent with the field definition. Per-tenant expression indexes are created deliberately and sparingly (justified, heavily-queried fields only), not automatically for every filterable field, keeping index sprawl bounded to genuinely hot fields.

### 2.3 Worked examples

**100,000 assets, 20 custom fields:** one row per asset in `custom_field_values`, one JSONB document per row holding all 20 keys — 100,000 rows total, not 2,000,000 (EAV would produce the latter).

**Filter assets by a custom select field** (`warranty_status = 'active'`) — via `CustomFieldQueryProvider.filterCondition()`:
```sql
SELECT a.* FROM assets a
JOIN custom_field_values cfv
  ON cfv.entity_id = a.id AND cfv.entity_type = 'asset' AND cfv.organisation_id = a.organisation_id
WHERE cfv.organisation_id = :org
  AND (cfv.values->>'warranty_status') = 'active';
```
Backed by the GIN index for broad containment-style filters, or a targeted expression index (2.2) if this specific field is high-traffic.

**Sort by a custom numeric field** (`purchase_cost`) — via `sortExpression()`:
```sql
... ORDER BY ((cfv.values->>'purchase_cost')::numeric) DESC;
```

**Group/report by a custom field, sum grouped by project code** — via `groupExpression()` + `expression()`:
```sql
SELECT (cfv.values->>'project_code') AS project_code,
       SUM((cfv.values->>'purchase_cost')::numeric) AS total_cost
FROM custom_field_values cfv
WHERE cfv.organisation_id = :org AND cfv.entity_type = 'asset'
GROUP BY (cfv.values->>'project_code');
```
The Reporting engine (§11) builds this by calling the provider once per reportable field it needs — it never constructs the JSONB path itself.

**Indexing frequently queried fields:** targeted expression indexes as in 2.2, added deliberately for fields an administrator/operator has identified as hot, not automatically for every filterable field.

### 2.4 Comparison against alternatives (updated)

| Approach | Type safety | Filter/sort perf | Reporting | Write cost | Verdict |
|---|---|---|---|---|---|
| **JSONB-only, no abstraction, ad hoc paths in every caller** | Weak, and inconsistently applied since every call site re-derives casts | Poor without targeted indexes | Every report/query site duplicates JSONB path logic — no single point of evolution | Cheap | Rejected as implemented this way — the storage is right, the missing abstraction was the problem |
| **Conventional EAV** | Requires joins/pivots to reconstruct a record; text-stored values are error-prone to sort/aggregate correctly | Poor — multi-field filters self-join repeatedly | Group-by/sum requires pivoting — awkward and slow | 100k assets × 20 fields = 2,000,000+ rows | Rejected |
| **Per-tenant physical columns** | Strong | Best possible | Best possible | High — schema migration per customer per field, operationally unworkable for self-hosted SME admins and incompatible with a shared-schema managed offering | Rejected |
| **Pooled generated shadow columns** (Revision 2 proposal) | Strong for indexed fields | Good | Good | Moderate | **Rejected per this review** — a generated column's expression is fixed at schema level and cannot represent a different JSON key per organisation without per-org columns (unworkable) or a shared key namespace across orgs (defeats per-tenant custom fields) |
| **JSONB canonical store + type-aware `CustomFieldQueryProvider` abstraction + targeted expression indexes on hot fields (chosen)** | Strong — enforced by field-type-driven expression generation at the one seam all callers use | Good on GIN for broad queries, native index performance on any field given a targeted expression index | Native GROUP BY/SUM via the same provider, no per-caller JSONB knowledge | Low — single JSONB write, indexes only where explicitly added | **Chosen** |

### 2.5 Performance evidence, not assumption

Before this subsystem is considered production-ready, the P0/P1 test suite includes a **custom-field benchmark harness** (not a unit test — a labelled, separately-run benchmark) seeded with realistic volumes (100k+ entity rows, 20 custom fields, a mix of filterable/non-filterable) measuring: unindexed JSONB filter latency, GIN-indexed filter latency, targeted-expression-indexed filter latency, sort latency, and grouped-aggregate latency. Results are recorded in `docs/benchmarks/custom-fields.md` so any future decision to add more aggressive indexing/materialization strategies is made from measured numbers on this schema, not speculation. This satisfies "prioritise correctness/maintainability now, but make future optimisation evidence-based."

---

## 3. Application Packaging

**Explicit concept separation** (data model, not just prose):

- **Installed application** — the application's code/package is present and registered in `installed_applications` (manifest loaded, migrations run). Does not imply usable.
- **Enabled application** — an installed application an administrator has turned on for this organisation; controls navigation/route exposure. An installed-but-disabled app is inert but its data/migrations remain intact (supports safe trial-disable without data loss).
- **Licensed application** — a valid signed license file (§13/§9 below) exists for this app + major version at this organisation. Enabling without a valid license is possible in a restricted/read-only or trial mode (product decision, not architectural blocker) but full functionality requires `enabled ∧ licensed`.
- **Compatible application** — the installed app version's declared `requiresCoreVersion` range is satisfied by the running Core version. Checked at every boot; an incompatible app is force-disabled with a clear diagnostic, never silently run.
- **Application version** — semver per app, independent of Core's own version and every other app's version. Tracked per-app in `installed_applications.version`, with its own migration ledger (`app_migrations` keyed by `app_id`).

These four booleans/attributes are independent columns/derived states on `installed_applications`, not conflated into one status flag — this is what lets "licensed but incompatible," "compatible but disabled," "installed but unlicensed trial" etc. all be representable without special-casing.

**Inactivity invariant (added per approval feedback):** an app whose code is present but not `enabled ∧ licensed ∧ compatible` must be operationally inert, not merely hidden. This is enforced structurally, not by convention:
- **Routes/API:** commercial app controllers are registered behind a Nest guard evaluated before the app's own route handlers — `ApplicationActiveGuard` — that checks the full `enabled ∧ licensed ∧ compatible` state on every request and returns 404 (not 403, to avoid confirming the route's existence) if not active. Route *registration* itself is also conditional on this state at boot for apps that are disabled at startup, so an inactive app's endpoints don't appear in the OpenAPI surface at all.
- **Navigation:** nav entries are filtered by the same active-state check at the point the frontend requests the nav manifest — an inactive app contributes zero nav entries.
- **Scheduled/background jobs:** the job scheduler checks active state immediately before executing any job whose `app_id` is not Core's own; an inactive app's scheduled jobs are skipped (and logged as skipped, not silently dropped) rather than deregistered, so re-enabling resumes normal scheduling without redefinition.
- **Event consumption:** the event dispatcher checks active state before invoking a consumer handler; an inactive app's registered event subscriptions are not invoked (events are not queued for later replay to a newly-enabled app unless the app's own onboarding logic explicitly requests a backfill — this is a per-app concern, not a Core guarantee).
- **APIs/data exposure:** because commercial data access always goes through the app's own service layer (never direct cross-app table access, per the module-boundary rule in §2 of the original spec), gating that service layer's entry points via `ApplicationActiveGuard` is sufficient — there is no separate path (report dataset, search index, webhook) that could expose an inactive app's data, since every one of those subsystems reaches app data only through the same gated service layer or through registrations (datasets, capabilities, search entity types) that are themselves only made available while active.
- This invariant is a P0-adjacent architectural rule enforced by the App Registry loader itself, so every future commercial app gets it automatically rather than having to reimplement the check.

**v1 packaging mechanism:** apps remain npm workspace packages compiled into the same Node process (unchanged from Rev 1) — but the loader is written against the same `HexyrnAppManifest` contract regardless of *how* the code arrived in the process. Concretely, the App Registry's loader has one job: given a set of manifest+code bundles, register and boot them. In v1, "how the bundle arrived" is "compiled into this build." Nothing in the registry, permission system, event bus, or reporting layer knows or cares about that fact.

**Why this isn't an accidental commercial lock-in:** because loading is behind that one seam, the evolution path is swapping *only* the loader's bundle-acquisition step, not the app contract itself:

1. **v1 (now):** monorepo workspace packages, compiled into one build. A customer "adds Requisite" by us shipping them a build that includes it (license-gated at runtime as above), or by them pulling an updated Docker image where it's compiled in but license-gated. Not a bespoke per-customer build — the same image ships all licensable apps; the license file (§9/§13) is what turns each on, so "add Requisite" is a license-file drop plus enabling it in admin UI, not a redeploy of different code.
2. **Near-future evolution (documented extension point, not built now):** apps published as independently versioned, digitally-signed npm-compatible packages fetched at deploy/update time (self-hosted admin runs `hexyrn app install requisite@1.x`, verifying package signature against Hexyrn's public key) and loaded into the same process at boot — still no dynamic marketplace, no arbitrary remote code execution, still same-process, just decoupled build/release cadence per app instead of one monolithic build containing everything.
3. **Longer-future (explicitly out of scope, only noted as a non-blocked direction):** out-of-process app hosting behind the same event bus/API contracts, if isolation needs ever justify it — nothing in the manifest contract assumes same-process, since apps only ever interact with Core through the registry-mediated interfaces (events, service interfaces, HTTP), never in-process object references reached into from outside their own module.

Because "install all apps in one compiled image, license-gate at runtime" is already how v1 ships every commercial app, adding Assets/Maintain/Competency/Margin later is a licensing operation, not an engineering one — the packaging question is decoupled from the commercial question by design.

---

## 4. Application Capabilities

**New App SDK concept, additive to the manifest:**

```ts
interface CapabilityDeclaration {
  capability: string;      // 'hexyrn.capability.purchasing.cost-source.v1'
  provides?: CapabilityInterfaceRef;  // the service interface this app exposes for the capability
  requires?: string[];     // capabilities this app wants to consume, if present
}
```

**Naming scheme (revised per approval feedback — prefix dropped):** `<domain>.<noun>.v<n>` — e.g. `purchasing.cost-source.v1`, `asset.registry.v1`, `maintenance.work-orders.v1`, `profitability.cost-consumer.v1`. The capability registry is itself the namespace (only Hexyrn Core's registry produces or resolves these identifiers), so a `hexyrn.capability.` prefix is redundant — the registry membership already establishes what a string is. Domain-scoped rather than app-scoped (describes *what*, not *who*), and explicitly versioned per capability, independently of the providing app's own version and of Core's version — an app can keep shipping v1.x of itself while adding a `.v2` capability alongside `.v1` for a transition period. Application IDs remain reverse-DNS (`com.hexyrn.requisite`) since those *do* need global namespace uniqueness outside any Hexyrn-controlled registry (e.g. if a customer or partner ever registers their own app ID). **Capability version, application version, and Core version are three independent axes** — none is derived from or assumed to track another.

**Resolution:** the App Registry maintains a `capability_providers` table (`capability`, `app_id`, `service_ref`) populated at each app's registration. A consuming app asks Core for "who provides `purchasing.cost-source.v1`?" via `CapabilityResolver.resolve(capability)`, never for "is Requisite installed?" — this is the entire point: Margin depends on the *capability* of being a cost source, not on Requisite specifically, so a future app (or a customer's own integration registering as a capability provider — see below) can satisfy the same dependency.

**Multiple providers coexisting:** `resolve()` returns a list, not a single result. Callers that need exactly one either (a) use the list to build a picker (e.g. a dashboard widget listing cost sources from every installed provider), or (b) apply a configured preference (an organisation-level setting, "primary cost source = Requisite," stored in Core config, editable by an admin) when a single answer is required. Core never hardcodes an assumption that only one provider can exist — that would immediately break the "Requisite and a customer's external ERP both provide cost data" case that the "open by design, no lock-in" principle requires.

**Zero-config native integration preserved:** because resolution happens automatically at the capability layer using only what's *installed and enabled* (per the §3 inactivity invariant — an inactive app is not a resolvable provider), two Hexyrn apps that both exist in the same deployment discover each other's capabilities with no customer action — installing and enabling Assets when Maintain is already active makes `asset.registry.v1` resolvable to it automatically, satisfying §29's zero-config requirement, while still leaving room for a customer's external system to register as an alternate provider through the integration framework (§12) without special-casing.

**Absent provider:** `resolve()` returns an empty list; consuming app features degrade gracefully (documented per-capability fallback behaviour, e.g. Margin shows "no cost source connected" rather than erroring) — same tolerance-of-absence principle as the event bus (§9/§27).

---

## 5. Reporting Semantic Relationships

Extends the dataset-registration model (Rev 1 §11) with an explicit, declared relationship layer — Core never introspects another app's schema or generates ad hoc joins.

**Relationship registration:** alongside `DatasetDefinition`, apps register `DatasetRelationship`s:

```ts
interface DatasetRelationship {
  fromDataset: string;          // 'assets.asset'
  fromField: string;            // 'assigned_person_id'
  toDataset: string;            // 'core.person'  or  'requisite.purchase_order_line'
  toField: string;              // 'id'
  cardinality: 'one-to-one' | 'many-to-one' | 'one-to-many';
  label: string;                // "Assigned Person"
}
```

This is metadata, not SQL — the report engine, not app code, translates an authorised relationship into a join, and only ever joins on registered relationships between registered, permission-scoped datasets. There is no mechanism for a report author to specify an arbitrary join condition.

**Join authorisation:** at query build time, for each relationship the engine intends to traverse, it checks that the requesting user holds view permission on **both** the `fromDataset` and `toDataset` (via the same `PermissionEvaluator` from §1/Rev1-§7) — if either side is unauthorised, that relationship is simply not offered in the report builder UI and not traversable via the API, rather than being traversed and then filtered (which would risk timing/count-inference leaks). This is the mechanism that prevents the "learn Manchester's totals through a report even though the user can't see Manchester" leak for joined data specifically.

**Cardinality:** declared per relationship (as above) so the engine knows whether traversing it can multiply row counts (one-to-many) — required for correct aggregate semantics (a naive join would silently inflate a SUM if the relationship fans out). The engine either pre-aggregates the "many" side before joining, or requires the report author to choose an aggregation for that side, depending on report shape; it never silently produces a fan-out-inflated sum.

**Cross-app availability:** a relationship where `toDataset` belongs to an app that isn't installed simply isn't registered (the registering app's own registration call fails safe / is skipped at boot if the target dataset doesn't exist), so it never appears as an option — this is the same "system tolerates absence" pattern as capabilities and events, applied to reporting.

**Aggregate permission enforcement:** unchanged from Rev 1 — every dataset in a report, joined or not, is queried through the org-scoped, permission-scoped query layer; a joined report's aggregate is the intersection of what the user can see on every participating dataset, not the union.

**Preventing arbitrary/unsafe joins:** three independent constraints, not one: (1) only *registered* relationships are traversable — there is no free-text join field in the report builder; (2) both endpoints must be *registered reportable datasets*, so an app can expose a relationship to one of its own internal tables without that table becoming independently queryable; (3) the permission check in "Join authorisation" above runs per-relationship, not just per top-level dataset, so a relationship into a dataset the user can't otherwise see is invisible even as a join target, not just as a standalone report.

**Worked example (Assets → Requisite):** Assets registers `assets.asset.purchase_source_id → requisite.purchase_order_line.id` (many-to-one). If Requisite isn't installed, this relationship registration is skipped and the field behaves as a plain reference value with no drill-through. If Requisite is installed but the current user lacks `requisite.purchase_orders.view`, the relationship exists in the registry but is excluded from that user's report-builder options and rejected if attempted via API. Only when both apps are installed and the user is authorised on both datasets does "show me asset total cost grouped by purchase order supplier" become an available cross-app report.

---

## 6. Authentication / Security Details

**CSRF — synchronizer token pattern, not SameSite-only:** a cryptographically random CSRF token is generated server-side and bound to the session record at session establishment (stored server-side alongside the session, not derived from or duplicated into a second cookie). It is delivered to the SPA once (e.g. via an authenticated bootstrap/`/api/v1/session` response body) and the frontend is required to echo it back in a custom header (`X-Hexyrn-CSRF`) on every state-changing cookie-authenticated request (POST/PUT/PATCH/DELETE); the server compares the header value against the token stored against that session server-side, rejecting the request if it's missing or mismatched. This is layered on top of SameSite=Lax cookies as defense-in-depth, per the instruction not to rely on SameSite alone — but there is deliberately no second CSRF-carrying cookie: the token lives in server-side session state and in the SPA's in-memory/JS-accessible storage only, which is what makes this a synchronizer-token strategy rather than double-submit-cookie. API-token-authenticated requests (service accounts, §12) are exempt — they aren't cookie-borne, so aren't CSRF-exposed the same way, but are still subject to origin validation below.

**Session ID rotation:** a new session ID is issued on every privilege-relevant transition — successful login, MFA completion, and password change — invalidating the pre-auth session token so a session fixated before authentication can't be reused after (classic session-fixation defense).

**Session handling after privilege changes:** role/permission changes for a user invalidate that user's cached permission set immediately (permission checks read current DB state, not a session-embedded snapshot, so there is no stale-permission window); account deactivation revokes all active sessions for that user synchronously as part of the deactivation transaction (this is the exact behaviour §49 requires being tested).

**Session revocation:** per-session ("log out this device") and global ("log out everywhere," triggered by password reset or explicit admin action) — both implemented as deletes/invalidation flags against the server-side session store, not reliance on cookie expiry.

**MFA recovery:** one-time single-use recovery codes generated at MFA enrolment (displayed once, hashed at rest like passwords), plus an administrator-assisted MFA reset path (requires a separate elevated permission, logged to audit) for the lost-device-and-recovery-codes case.

**TOTP secret encryption/key management:** TOTP secrets encrypted at rest using envelope encryption — a per-installation master key (from environment/secrets file, never committed, documented as the customer's responsibility to protect under Shared Responsibility) wraps per-secret data keys stored alongside the encrypted secret. Master key rotation re-wraps data keys without re-issuing user TOTP enrolments.

**Security headers / CSP:** `Content-Security-Policy` restricting script/style/connect sources to self plus explicitly allowlisted origins (no inline scripts without nonce), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (or frame-ancestors in CSP), `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security` (when served over TLS, which is expected to sit behind a reverse proxy per §43's public-internet assumption).

**Trusted proxy handling:** self-hosted deployments commonly sit behind a reverse proxy (nginx/Caddy/Traefik) — the app trusts `X-Forwarded-*` headers only from an explicitly configured trusted-proxy IP/CIDR list (never trusts them by default from arbitrary clients, which would otherwise allow IP/protocol spoofing that undermines rate limiting and audit logging).

**Origin validation:** state-changing requests additionally validate `Origin`/`Referer` against a configured allowlist of the installation's own base URL(s) — a second, independent layer alongside the CSRF token, catching misconfigurations where the token check might be bypassed by a client bug rather than an attack.

**Account recovery:** admin-initiated recovery for a locked-out user (reset invitation-style flow, logged to audit, requires an elevated permission) distinct from self-service password reset (§9 Rev 1, unchanged) — self-service recovery never bypasses MFA; admin-assisted recovery explicitly can (that's the recovery path), and doing so is itself an audited, permission-gated action so it can't be used quietly.

---

## 7. Organisation / Install Separation

Corrected: **Installation → Organisation(s)** is now explicit in the data model, not implicit-single-row as Rev 1 stated.

- `installations` — one conceptual row representing this deployment (Core version, install id, install-level config: SMTP, storage provider, license verification key location). Not itself organisation-owned data.
- `organisations` — one-to-many under an installation. Every organisation-owned table still carries `organisation_id NOT NULL` exactly as Rev 1 described; that part of the design already supported this and required no change — what changes is that the *product* explicitly models "installation" as its own top-level entity rather than treating the single organisation row as a stand-in for the installation.
- **v1 product behaviour:** the self-hosted bootstrap flow (§4 of the original spec) creates exactly one organisation as part of first-run setup, and the UI does not expose "create another organisation" — this is a product/UX constraint for v1, not a schema constraint. The schema already permits more.
- **Future managed/multi-org hosting:** becomes "allow bootstrap/admin flow to create additional `organisations` rows under the same `installations` row," with all existing per-organisation scoping (RLS, base-repository injection, permission evaluation, capability resolution, reporting) unchanged, because none of those mechanisms were ever written against "there is exactly one organisation" — they were already written against `organisation_id` as a first-class scoping key. This is the "preserves a clean path" property the review asked for.

---

## 8. Row-Level Security — Connection Pooling Safety

This needed a concrete mechanism and a concrete test, not just a statement of intent.

**Mechanism:** Postgres session-local `SET LOCAL app.current_organisation_id = '<uuid>'` (transaction-scoped, not connection/session-scoped — `SET LOCAL` automatically reverts at transaction end, `COMMIT` or `ROLLBACK`, regardless of what the pooled connection does next). RLS policies on every organisation-owned table read this via `current_setting('app.current_organisation_id', true)::uuid`.

```sql
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON assets
  USING (organisation_id = current_setting('app.current_organisation_id', true)::uuid);
```

**Why `SET LOCAL` and not `SET` (session-level):** the critical property is that the setting cannot outlive the transaction, so it cannot leak into a later, unrelated use of a pooled physical connection. The request-handling code wraps every request's DB work in an explicit transaction that begins with `SET LOCAL app.current_organisation_id = $1` as its first statement — never a bare `SET`, never issued outside a transaction boundary, enforced by a single repository-layer wrapper (`withOrgContext(orgId, fn)`) that all data access goes through, so there is exactly one place this could be gotten wrong rather than one per query.

**Defense if a transaction is somehow left open/misused:** the connection pool additionally runs `DISCARD ALL` (or at minimum `RESET ALL`) on connection release back to the pool as a second, redundant safety net — belt-and-braces on top of `SET LOCAL`'s inherent transaction scoping, so even a coding mistake that skipped the transaction wrapper can't leave org context set on a connection returned to the pool.

**Required automated test (to be written in P0, not deferred):**

```ts
it('never leaks organisation context across a pooled connection reused for a different org', async () => {
  // Force the pool down to a single connection so reuse is guaranteed, not probabilistic.
  const pool = createTestPool({ max: 1 });

  await withOrgContext(pool, orgA.id, async (tx) => {
    await tx.query('SELECT set_config($1,$2,true)', ['app.current_organisation_id', orgA.id]);
    const rows = await tx.query('SELECT * FROM assets'); // seeded: orgA has assets, orgB has assets
    expect(rows.every(r => r.organisation_id === orgA.id)).toBe(true);
  });

  // Same underlying physical connection is now reused for orgB.
  await withOrgContext(pool, orgB.id, async (tx) => {
    const leaked = await tx.query(
      "SELECT current_setting('app.current_organisation_id', true) AS ctx"
    );
    expect(leaked[0].ctx).toBe(orgB.id); // not orgA.id — proves no residual context
    const rows = await tx.query('SELECT * FROM assets');
    expect(rows.every(r => r.organisation_id === orgB.id)).toBe(true); // never sees orgA rows
  });
});

it('rejects any query issued outside an org-context transaction on an RLS-protected table', async () => {
  // A raw query bypassing withOrgContext() must return zero rows, not all rows —
  // proves RLS is fail-closed (current_setting(...) with missing_ok returns NULL,
  // and the policy's equality check against NULL is never true).
  const rows = await pool.query('SELECT * FROM assets');
  expect(rows.length).toBe(0);
});
```

This pair of tests is the baseline proof artifact; the full required matrix is below.

### 8.1 Core invariant

**Every execution context accessing organisation-owned data must have an explicit organisation context. This applies identically to HTTP requests and non-HTTP execution.** Background jobs, scheduled tasks, event consumers, and webhook deliveries must never infer, default, or fall back to an organisation (e.g. "the only organisation in this installation," "the last one used," "the job's creator's current org") — the `organisation_id` must be carried explicitly as data on the job/event/task payload itself, exactly as `organisation_id` is carried explicitly on every domain row. If organisation context is absent at the point of data access, access fails closed (RLS denies via `current_setting(..., true)` returning NULL, and the application-layer `withOrgContext` wrapper below refuses to run the callback at all without an explicit id — there is no "run without org context" code path, only "run with an explicit org context" or "reject before touching the database").

Concretely: `withOrgContext(orgId: string, fn)` has no overload that omits `orgId`; job/event/webhook payload types include `organisationId` as a required (non-optional) field at the TypeScript level, so a job that doesn't know its organisation cannot be constructed, not just cannot be run.

### 8.2 P0 security test matrix (all mandatory)

Beyond the two tests in §8 above (pooled-connection reuse across orgs; fail-closed with no context), the P0 suite covers organisation isolation across:

1. **Successful commit** — org context set, transaction commits, only that org's rows are visible/written; the immediately following reused connection has no residual context (§8's test, generalized).
2. **Transaction rollback** — org context set, transaction rolled back (simulated business-rule failure); reused connection confirms no context leak and no partial write survives.
3. **Thrown application exception mid-transaction** — an unexpected exception inside `withOrgContext`'s callback still results in the transaction being rolled back (via the wrapper's `try/finally`) and the connection returned to the pool clean — proves the safety net isn't bypassed by unhandled errors, not just handled ones.
4. **Database/connection error where practical** — simulated connection drop mid-transaction; verifies the pool discards (not "cleans and reuses") a connection it cannot confirm is in a known state, so a connection of uncertain state is never handed to a different organisation's request.
5. **Concurrent requests for different organisations** — N simultaneous requests for distinct orgs against a small pool, asserting each response only ever contains its own org's data, run repeatedly (stress-style) to catch races that a single sequential test wouldn't surface.
6. **Nested service calls** — a service method that calls into another Core/app service internally (e.g. workflow transition triggering a notification service call) propagates the same org context rather than each layer re-deriving or, worse, omitting it; test asserts the innermost call still sees the correct `current_setting`.
7. **API-token/service-account requests** — a scoped API token is itself bound to exactly one organisation at issuance; the request pipeline for token-authenticated requests sets org context from the token's bound org, not from any request body/header the caller could supply, and a test asserts a token for org A cannot be used to read org B data by manipulating request parameters.
8. **Background jobs** — a queued job carrying `organisationId` in its payload runs its handler inside `withOrgContext(job.organisationId, ...)`; test enqueues jobs for two orgs into a shared queue/worker pool and asserts each handler only ever sees its own org's data.
9. **Scheduled jobs** — recurring jobs (e.g. per-org digest emails) are enumerated per organisation at schedule time (one job instance per org, each with its own explicit `organisationId`), never as a single cross-org sweep that infers org from row data after the fact; test asserts a scheduled job cannot be constructed without a target org.
10. **Event consumers** — the event dispatcher passes the publishing event's `organisationId` (carried on every event payload, since events describe changes to organisation-owned data) into `withOrgContext` before invoking each subscriber; test publishes events for two orgs and asserts subscriber handlers never cross-contaminate.
11. **Webhook processing** — both directions: outbound delivery construction reads only the subscribing organisation's data (a webhook subscription is itself org-scoped), and inbound delivery/retry bookkeeping (delivery history rows) stays correctly scoped per subscription's org even when the delivery worker processes a mixed queue across orgs.
12. **Imports/exports with asynchronous DB work** — a long-running import/export job carries `organisationId` explicitly on its job record exactly as in (8)/(9); test asserts an export job cannot begin streaming rows without a bound org context, and that two concurrently-running exports for different orgs never interleave rows.

Application-layer org scoping (the base-repository injection from Rev 1) and RLS remain fully independent: the repository layer never relies on RLS to "clean up" a missing `WHERE organisation_id`, and RLS never relies on the repository layer having done its job — either one alone is sufficient to prevent cross-org data return, and the test matrix above exercises both layers together across every execution context, not only the HTTP request path.

---

## 9. Licensing Concepts

Three independent, separately-recorded properties per (app, major version, organisation), corrected from Rev 1's single license-file model:

- **LICENSE** — a signed license file grants perpetual right to use a specific `(app_id, major_version)`. Recorded permanently once verified; **verification failure or absence of a network/activation service never revokes an already-recorded valid license** — the check at boot is "do we hold a previously-verified valid license record," not "can we re-verify online now." A license, once validated, is durable local state.
- **COMPATIBILITY** — derived at boot by comparing the installed app version's `requiresCoreVersion` range against the running Core version. Independent of licensing: an app can be perfectly licensed and simultaneously incompatible (customer upgraded Core without upgrading the app, or vice versa) — compatibility failure disables the app with a diagnostic, it does not touch the license record.
- **SUPPORT** — a separate entitlement flag/date range (also part of the signed license payload, but logically distinct) indicating whether this app version currently receives updates/security patches from Hexyrn. Support lapsing changes nothing about runtime behaviour — the app keeps running exactly as licensed; support status is informational/administrative (surfaced in the health/diagnostics area, §16 P3) so the customer knows they're on an unsupported version, not a runtime gate.

**Data model:**

```sql
CREATE TABLE application_licenses (
  id UUID PRIMARY KEY,
  organisation_id UUID NOT NULL,
  app_id TEXT NOT NULL,
  licensed_major_version INT NOT NULL,
  license_payload JSONB NOT NULL,      -- decoded signed payload, retained verbatim
  signature_valid_at TIMESTAMPTZ NOT NULL,  -- when we last successfully verified it
  support_expires_at TIMESTAMPTZ,      -- nullable = perpetual/no support tracking
  UNIQUE (organisation_id, app_id, licensed_major_version)
);
```

A row, once inserted with a valid signature, is never deleted by anything other than explicit administrator action — boot-time checks read this table, they do not require re-verifying the signature against a live service each time (the signature was already asymmetrically verified once; re-verifying the stored payload's signature on every boot is fine and still fully offline, since it's pure local cryptographic verification against the embedded public key, no network call).

**Upgrade behaviour:** installing app v2 when only a v1 license exists is permitted (installed=true) but v2 runs unlicensed/restricted (per the installed/enabled/licensed/compatible separation in §3) — **critically, the v1 license row and the customer's v1 data are untouched.** If the customer rolls back to v2's predecessor build or simply never enables v2, their legitimately licensed v1 functionality is unaffected. This directly satisfies "accidentally installing an unlicensed newer major version must not destroy or invalidate the older installation."

**Rollback behaviour:** because app versions are independently tracked with their own migration ledger (§3), rolling back an app's code to an earlier compiled build is safe with respect to licensing (the v1 license row is still there, still valid) but is only safe with respect to *data* if no v2-only migration has run an irreversible transformation — this is a standard migration-design discipline (documented requirement: destructive migrations must ship a tested down-migration or an explicit "not reversible past this point" flag surfaced to the admin before upgrade), not a licensing concern per se.

---

## 10. Backup UX

Administrative surface: **Administration → System → Backup**, distinct from the raw "coordinated backup unit" mechanism (Postgres dump/WAL + files directory + config + installed app/version manifest) described in Rev 1, which becomes the thing this UI orchestrates rather than something an admin operates directly.

**v1 scope (P3, per phased plan):**
- **Backup Now** — on-demand trigger, runs the coordinated backup (DB + files + config + version manifest) as one atomic job, writes a manifest recording exactly what was included and its checksums.
- **Destination** — configurable target: local path (default, simplest for a first SME deployment) or an S3-compatible bucket (reuses the same storage abstraction already built for file attachments, §20 of the original spec) — no bespoke backup-transport code needed.
- **Schedule** — cron-style recurring backup (reuses the Postgres-backed job scheduler already in the architecture, no new scheduling subsystem).
- **Retention** — simple count- or age-based retention policy (keep last N, or keep last N days), applied automatically after each successful run.
- **Last successful backup / backup health** — surfaced on the System Health page (§48 of the original spec) alongside DB connectivity, migration status etc. — a red/amber/green indicator plus timestamp, so a lapsed backup schedule is visibly wrong, not silently wrong.
- **Restore workflow** — a guided, explicitly destructive-warned flow (confirmation step naming exactly what will be overwritten), runnable from a maintenance/setup mode rather than against a live running instance, producing a clear success/failure result and re-running health checks afterward.
- **Explicit off-site warning:** if the configured destination is the same local disk as the primary database (i.e., "local path" pointing at the same volume), the UI surfaces a persistent, non-dismissable-until-acknowledged warning that this does not protect against disk/host failure and recommends an off-machine destination — addresses the Shared Responsibility Model requirement (§42) that backups be the customer's responsibility without letting a naive default configuration silently provide false confidence.
- **Restore testing guidance:** documentation (not automated in v1) recommending periodic restore drills into a non-production instance; the restore workflow above is deliberately the same code path whether used for a drill or a real incident, so "practicing" a restore is genuinely representative rather than a separate, untested code path.

This remains within the Shared Responsibility Model as originally specified (§42) — Hexyrn makes correct backup behaviour easy and visible; the customer still owns the decision to configure an off-site destination, run schedules, and periodically test restores.

---

## Carried Forward Unchanged From Revision 1

Technology stack (TypeScript/NestJS/Fastify, PostgreSQL, React, REST/OpenAPI), modular-monolith process model, repository structure, PostgreSQL-backed job queue, transactional event outbox for the internal event bus, workflow/approval engine design (declarative, no executable configuration), file storage abstraction, structured/redaction-enforced logging tied to field classification, public API/webhook design, and the phased P0–P3 implementation plan — all unchanged, since the review approved this direction and none of the ten points required revising them. The App SDK manifest (§8, Rev 1) gains the `CapabilityDeclaration` addition from §4 above but is otherwise unchanged.

---

---

## Frozen Decisions

The following are approved and frozen as of Architecture v1.0. They are not to be reopened during P0–P3 implementation unless implementation reveals a genuine contradiction, security issue, or materially better solution — in which case implementation stops, the issue is documented, and review happens before any architectural change:

TypeScript; NestJS/Fastify; PostgreSQL; React; REST/OpenAPI; modular monolith; PostgreSQL-backed jobs; Installation → Organisation(s); Person separate from User; server-side sessions; Argon2id; TOTP MFA; deny-by-default RBAC; central PermissionEvaluator; application-layer organisation scoping; PostgreSQL RLS; custom fields using JSONB behind a storage abstraction; configurable forms; numbering; declarative workflows; declarative approvals; checklists; notifications; secure file abstraction; audit framework; privacy-safe structured logging; transactional event outbox; App Registry; capability discovery; permission-aware reporting datasets; semantic dataset relationships; dashboards; exports; platform search; REST API; scoped service accounts/API tokens; signed webhooks; external integration framework; licence/compatibility/support separation; offline-verifiable perpetual app licensing; backup/restore framework; diagnostics/support bundles; Docker-oriented self-hosting.

**Status: Hexyrn Core Architecture v1.0 — APPROVED FOR IMPLEMENTATION.**

Proceeding with P0 only. P1–P3 require separate authorisation after P0 review.
