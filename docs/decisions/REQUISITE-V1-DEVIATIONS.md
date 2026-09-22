# Hexyrn Requisite v1 - Security Review, Deviations & Technical Debt

Requisite (`com.hexyrn.requisite`) is Hexyrn's first real commercial
application, built entirely on Core P0-P2 through the supported App SDK.
This file records the security review (item 41), architecture deviations,
and genuine remaining technical debt - the same discipline
P0-DEVIATIONS.md/P1-DEVIATIONS.md/P2-DEVIATIONS.md established for Core
itself.

## Security review (item 41)

Each concern named in the brief, and its actual disposition:

| Concern | Disposition |
|---|---|
| Cross-organisation access | RLS+FORCE on every `requisite_*` table (migration 0033); proven with a dedicated org-isolation test in every service's test suite (suppliers, requisitions, POs, goods receipts, RFQs). |
| Requisition/PO/supplier/goods-receipt IDOR | Every `getX`/`getXRaw` method filters by `organisation_id` AND `id` together, on top of RLS as a second layer - proven not-found (never another org's data) in every isolation test. |
| Approval bypass | Decisions run through Core `ApprovalService.decide()`, permission-gated identically to every other Core-mediated action; no direct-write path to `approval_steps` exists in Requisite's own code. |
| **Self-approval bypass** | **Found and fixed** - see below. |
| PO generation without approval | `PurchaseOrderService.generateFromRequisition()` checks `requisition.status === 'approved'` server-side, unconditionally, regardless of caller (proven: `PO GENERATION WITHOUT APPROVAL` test). |
| Duplicate PO creation | Prevented by an atomic `UPDATE...WHERE status='approved'` claim before any PO row is created - proven with a genuine concurrent `Promise.allSettled` race, not a mock. |
| Over-receipt race | Prevented by an atomic `UPDATE...WHERE quantity_received + $new <= quantity_ordered`, backed by a database `CHECK` constraint as a second layer - proven with a genuine concurrent over-receipt race. |
| Unauthorised cancellation | `cancelRequisition`/PO cancellation both re-check current status server-side; `@RequirePermission('requisite.requisitions.cancel')` gates the HTTP surface. |
| Commercial licence bypass | Item 33's full 9-scenario suite proves the real Ed25519 verification path cannot be bypassed (wrong org/product/version/signature/keypair all rejected). |
| Report/export leakage | Requisite's reporting datasets are registered with `required_permission` exactly like Core's own - proven rejected-without-permission in the reporting integration tests; exports inherit the same dataset-permission gate via `ExportService`. |
| Search leakage | `SearchService.search()` only ever searches entity types the caller holds the registered permission for - proven (a subject with no permission gets zero results, not an error). |
| API scope bypass | Proven via the e2e suite: a service account without `requisite.requisitions.create` gets 403 attempting to create a requisition through the real HTTP API. |
| Webhook data leakage | Webhook payloads are deliberately constructed (`{ requisitionId, requisitionNumber }` etc.), never a raw DB record dump - see each `ctx.events.publish` call site. |
| Unsafe supplier imports | `ImportService`'s existing allowlisted-field-only mapping applies; the Requisite import handler treats a repeated `supplier_number` as an UPDATE, never a silent duplicate INSERT - proven. |
| Attachment access | Not yet exercised - Requisite v1 does not yet call Core Files for quote/PO/delivery-note attachments (see Technical Debt). |
| Mass assignment | Every service method takes an explicit typed input DTO (`CreateSupplierInput`, `CreateRequisitionInput`, etc.) - never a raw request body passed through to an `insertInto`/`updateTable` call. |
| Monetary manipulation | All monetary arithmetic is bigint-minor-unit (`money.ts`); no floating-point ever enters a stored total; PO/requisition totals are always server-computed from line inputs, never accepted as a client-supplied total. |
| Workflow bypass | Every state transition (submit/approve/reject/order/receive/cancel) goes through `ctx.workflow.transition`, which is Core's own permission-gated state machine - Requisite never writes `workflow_instances` directly. |

### Finding: self-approval bypass (fixed)

Core's `ApprovalService` has no concept of "requester" - `decide()` only
checks the decider holds the step's `approverPermission`. A requester who
also held `requisite.requisitions.approve` could therefore approve their
own requisition. Fixed at the **application** layer (not a Core change,
since self-approval policy is domain-specific, not a platform primitive):
`RequisitionService.decide()` now rejects a decision where
`actorUserAccountId === requisition.requester_user_account_id`, before
`ctx.approvals.decide()` is ever called. v1 ships this as a hard rule with
no configurable exception - a genuine, documented v1 simplification (see
Technical Debt).

## Architecture/Core gaps discovered

**None that required modifying Core.** Every mechanism Requisite needed
(Numbering, Workflow, Approval with rich context payloads, Events with
payload-schema validation, Custom Fields, Forms, Files, Notifications,
Scheduling, Reporting/Dashboards/Search/Import/Export, Service Accounts,
Webhooks, real Ed25519 Licensing) worked as designed for a real commercial
app's actual domain logic, including its concurrency-sensitive paths
(optimistic-concurrency requisition edits, atomic PO-generation/issue
claims, atomic over-receipt prevention). The self-approval gap above is
not a Core gap - it is exactly the kind of domain policy the App SDK
correctly leaves to the application layer.

## Technical debt (genuine, remaining)

- **Consolidated PO generation** (item 8's "consolidation of multiple
  approved reqs into one supplier PO") is not implemented - v1 only
  supports one-requisition-to-one-PO (optionally to multiple suppliers via
  multiple calls). Deliberately not over-built per item 45.
- **Files/attachments** (item 16) are not yet wired into any Requisite
  service - quotes, PO documents, and delivery notes cannot yet be
  attached via Core Files. The domain schema and Core mechanism both exist;
  the integration call sites are not yet written.
- **Notifications** (item 17) and **delivery-monitoring reminders** (item
  18) are not yet wired - Core `NotificationService`/`ScheduledJobService`
  are proven working elsewhere (Requisite's own scheduled-report reuse
  pattern from P2), but no Requisite service yet calls them.
- **Purchase Order PDF document** (item 37) is not yet generated - Core's
  `ExportService.toPdfBuffer()` (proven in P2) is the correct mechanism;
  no Requisite call site exists yet.
- **Custom fields** (item 14) are not yet registered for any Requisite
  entity - the mechanism is proven elsewhere in Core/reference-app tests;
  no Requisite-specific field definitions have been added yet.
- **Self-approval prevention has no configurable exception** - v1 is a
  hard rule (see above), not yet driven by the "configured policy" the
  brief allows for.
- **The HTTP API surface is read/create-only for the core resources** -
  `submit`/`decide`/`issue`/`generate-po`/`record-receipt` are proven at
  the service layer and exercised end-to-end via direct service calls in
  the e2e webhook test, but do not yet have their own dedicated HTTP
  routes on `RequisiteController`.
- **Demo data** (item 43) - not yet implemented as of this commit.
- **Multi-currency** is schema-ready (every relevant table carries its own
  `currency` column) but the service layer does not yet perform any
  currency conversion; v1 assumes same-currency comparison, matching the
  brief's "design for multi-currency even if v1 UI optimises for one."
- **Attachment upload uses base64-in-JSON, not multipart/form-data** - no
  multipart parser is wired into the Fastify adapter yet. A documented v1
  simplification, not a silent limitation.

## Items 34-36 (Navigation/UX) - API surface confirmation

No React UI was built for Requisite v1 (out of scope for this backend
phase); the brief asked that the API surface at minimum be confirmed to
support the described UX flows, proven as follows:

- **Item 34 (navigation)**: `REQUISITE_APP_MANIFEST.navigation` declares
  exactly the seven sections named (Home, Requisitions, Purchase Orders,
  Goods Receipts, Suppliers, Quotes/RFQs, Reports), each permission-gated.
- **Item 35 (requisition creation flow)**: `POST .../requisitions` (reason
  + lines, returns a computed `estimated_value_minor`) -> `POST
  .../requisitions/:id/attachments` (optional quote/spec) -> `POST
  .../requisitions/:id/submit` - proven as one continuous real-HTTP
  sequence in the e2e suite.
- **Item 36 (approver UX)**: `GET .../requisitions/:id` returns requester,
  lines, total, supplier preference, and cost reference in one call;
  `GET .../requisitions/:id/approval-history` returns prior decisions
  (decider, decision, comment) without a second admin screen; `GET
  .../requisitions/:id/attachments` returns quotes/specs; the decision
  itself is `POST .../requisitions/:id/decisions`. All four routes proven
  over real HTTP.

Architecture terminology (capability, event bus, dataset registry,
workflow instance) never appears in any Requisite HTTP response - request/
response bodies use plain domain fields (`status`, `requisition_number`,
`estimated_value_minor`, etc.), matching item 34's requirement even
without a UI to visually confirm it in.

## UI Completion phase update

A real React customer-facing UI was subsequently built on top of the
existing Core frontend shell, closing most of the above. Items 34-36 are
now genuinely confirmed with a rendered UI, not just an API proof, via
the Playwright E2E suite (`e2e/tests/requisite-lifecycle.spec.ts`).

### Frontend security review (item 27)

- **XSS**: no `dangerouslySetInnerHTML` anywhere in the Requisite frontend
  (`grep -rn dangerouslySetInnerHTML apps/web/src` returns nothing) -
  supplier names, requisition purposes, filenames, and comments are all
  rendered through normal JSX text interpolation, which React escapes
  unconditionally.
- **Sensitive data in browser persistence**: no `localStorage`,
  `sessionStorage`, or direct `document.cookie` access anywhere in the
  Requisite frontend - the session remains an httpOnly cookie (P0), and
  the CSRF token lives only in an in-memory JS variable for the lifetime
  of one page load (see the E2E test's own commentary on why this means
  every navigation must be a client-side route change, never a full
  reload, mid-session).
- **Malicious filenames**: the real multipart upload path relies entirely
  on Core `FileService`'s existing protections (random server-generated
  `storage_key`, never the client filename; MIME-sniffed against actual
  bytes) - the frontend never constructs a filesystem path from a
  filename, and `original_filename` is only ever rendered as plain text.
- **CSRF**: every non-GET Requisite request (including the new multipart
  upload) carries the `X-Hexyrn-CSRF` header via the existing synchronizer
  token check.
- **Permission assumptions**: the UI hides actions it doesn't expect to
  succeed (no Approve button without the pending step, no Generate PO
  before 'approved') as a UX convenience only - every action is still
  independently enforced server-side (proven throughout the backend
  phase's security review), and self-approval is blocked in the backend
  regardless of what the UI shows.
- **Not yet reviewed**: URL injection in file-attachment `href`s beyond
  the one PDF-download link exercised by the E2E test; no dedicated
  fuzzing of supplier-name/description fields for markup-like content was
  performed (React's default escaping makes stored XSS structurally
  unlikely, but this was not independently proven with an adversarial
  input test).

### Responsive/accessibility status (items 22/23)

- **Confirmed**: `Input`'s label-association bug (missing `htmlFor`/`id`
  when neither `id` nor `name` was set) was found and fixed at the Core
  Design System level, affecting every existing Input usage, not just
  Requisite's fast-editing line rows. `StatusBadge` never conveys status
  by colour alone (always renders the text label). All primary flows use
  real `<label>`/`aria-label` associations, exercised implicitly by every
  `getByLabel(...)` call succeeding in both the Vitest component tests
  and the Playwright E2E run (a mislabeled control would have failed
  those locators).
- **Not done**: no systematic WCAG 2.2 AA audit (automated tooling such as
  axe-core, or a manual screen-reader pass) was run against any screen;
  no dedicated tablet/mobile viewport testing was performed (the design
  system's layouts use CSS grid/flexbox with reasonable wrapping, but this
  is an untested assumption, not a verified claim); colour contrast
  ratios were not measured against WCAG thresholds. This is genuine
  remaining debt, not a silent gap - see the phase report's verdict.

### Requisite v1 UI verdict (superseding any earlier partial-progress note)

See the final UI-completion phase report for the authoritative verdict;
this file's job is the running technical record, not the sign-off
statement itself.
