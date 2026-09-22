# Hexyrn Requisite v1

Requisite (`com.hexyrn.requisite`) is Hexyrn's procurement and purchasing
application - a purchasing-control process for organisations that have
outgrown spreadsheets/email/paper forms, built entirely on Core P0-P2
through the supported App SDK. It is not an ERP, accounting package, or
inventory application.

## Domain model

Supplier -> Requisition (+ Requisition Lines) -> [RFQ + Quotes, optional]
-> Purchase Order (+ Purchase Order Lines) -> Goods Receipt (+ Goods
Receipt Lines, one-to-many per PO). All monetary values are stored as
`INT8` minor units (pence/cents) - never float/NUMERIC - see
`apps/api/src/apps/requisite/money.ts`. Quantities are `NUMERIC(14,4)`
(genuinely fractional units are legitimate). Full traceability is
maintained via `source_requisition_id`/`source_requisition_line_id`/
`purchase_order_line_id` foreign keys throughout, drillable in both
directions.

Schema: `apps/api/src/db/migrations/0033_requisite_domain.sql`.

## Permissions

`requisite.suppliers.{view,manage}`, `requisite.requisitions.{view,create,
edit,submit,approve,cancel}`, `requisite.purchase-orders.{view,create,
issue}`, `requisite.goods-receipts.{view,create}`, `requisite.rfqs.manage`,
`requisite.reports.view` - see `requisite.manifest.ts`. Names are
considered stable once published (item 31).

## Workflow

Default requisition lifecycle (Core Workflow, `requisition-lifecycle`):
`draft -> submitted -> awaiting_approval -> approved -> ordered ->
partially_received -> received -> closed`, plus `rejected`/`cancelled`.
Requisite owns the semantic meaning of each state (what triggers a
transition); Core owns the state-machine mechanism (permission-gated
transitions, optimistic concurrency). Configurable through Core's normal
workflow-definition mechanism, not hardcoded into application code.

## Approval

Default: a single step, any holder of `requisite.requisitions.approve`
(`requisition-approval` definition, registered idempotently by
`RequisiteOnboardingService`). Context supplied to every approval request:
requester, org unit, location, estimated value, currency, category, cost
object reference, preferred supplier, line count. **Self-approval is
blocked by a hard application-layer rule** (the requester can never decide
their own requisition, regardless of what permissions they hold) - see
`docs/decisions/REQUISITE-V1-DEVIATIONS.md` for why this isn't a Core
mechanism. Multi-step, value-threshold approval chains (the brief's
example: <£500 -> Dept Manager; £500-£2000 -> +Purchasing; >£2000 ->
+Director) are configured through Core Approval's own definition format,
not Requisite-specific code.

## Numbering

`requisition` -> `REQ-000001`, `purchase-order` -> `PO-000001`,
`goods-receipt` -> `GRN-000001`, `rfq` -> `RFQ-000001`, `supplier` ->
`SUP-00001`. All via Core Numbering; customer-configurable through Core's
supported sequence-registration mechanism.

## Events (all versioned, item 19)

`requisite.requisition.{created,submitted,approved,rejected}.v1`,
`requisite.purchase-order.{created,issued,completed}.v1`,
`requisite.goods-receipt.created.v1`, `requisite.goods-received.v1`.
Payloads are deliberately selected stable identifiers, never raw DB
records.

## Capabilities

`purchasing.procurement.v1`, `purchasing.cost-source.v1`,
`purchasing.supplier-registry.v1`, `purchasing.goods-receipt.v1` - see
items 21/22/23 for the future Assets/Stock/Margin integration contracts
these capabilities/events are designed to support without Requisite
building those products itself.

## Reporting

Datasets: `requisite.suppliers`, `requisite.requisitions`,
`requisite.purchase_orders`, `requisite.goods_receipts` - semantic, not
raw tables (field-level filterable/sortable/groupable/measure
declarations). Relationships: PO -> Supplier, PO -> Requisition, Goods
Receipt -> PO. Built-in reports: Open Purchase Orders, Purchasing by
Supplier. Dashboard widgets: Open Purchase Orders (KPI), Spend by Supplier
(bar chart). All registered by `requisite-p2-extensions.ts`, riding
entirely on Core's P2 reporting/dashboard/search/import infrastructure.

## Public API

`GET/POST /api/v1/requisite/suppliers`, `GET/POST
/api/v1/requisite/requisitions`, `GET /api/v1/requisite/requisitions/:id`,
`GET /api/v1/requisite/purchase-orders[/:id]`, `GET
/api/v1/requisite/goods-receipts/:id`, `POST
/api/v1/requisite/purchase-orders/:id/goods-receipts`. Reachable
identically by a session cookie or a service-account API key (`Authorization:
Bearer hxk_...`) via Core's unified `SessionAuthGuard`; each route is
gated by its own `@RequirePermission`. See technical debt: the
submit/approve/issue/generate-PO actions are proven at the service layer
but do not yet have dedicated HTTP routes.

## Webhooks

Any org-configured webhook endpoint can subscribe to any of Requisite's
published event types (e.g. `requisite.purchase-order.issued.v1`) via
Core's existing per-organisation webhook configuration - no
Requisite-specific webhook code is needed; this rides entirely on the P2
Webhook Framework's existing `dispatch_queue(kind='webhook')` routing.

## Licensing

Requisite is paid; Core remains free. Real Ed25519 verification (ADR
0006) - a valid, cryptographically signed licence for the correct
organisation/appId/majorVersion activates the app; everything else
(missing, invalid signature, wrong org, wrong product, wrong major
version, forged keypair) keeps it inactive. Support expiry does not
disable a perpetual licence. No network call is ever made to verify a
licence. See `apps/api/src/apps/requisite/__tests__/requisite-licensing.integration.spec.ts`.

## Configuration

Admin setup order: enable + license Requisite for the organisation ->
grant `requisite.*` permissions to the appropriate roles -> configure
approval rules (Core Approval) if the SME default single-step policy
isn't sufficient -> configure numbering prefixes if the defaults aren't
wanted -> configure categories (a plain text field today - no fixed
category list is enforced) -> configure default forms (Core Forms) if
field visibility/ordering needs to change -> import suppliers if
migrating from a spreadsheet -> begin creating requisitions.

## Imports

Supplier import (`requisite.supplier` entity type): preview/validation/
row-level-errors via Core's Import Framework; a repeated `supplier_number`
UPDATES the existing supplier rather than creating a duplicate (explicit
duplicate-handling strategy, never silent duplicate creation).

## Demo data

`seedRequisiteDemoData()` (`apps/api/src/apps/requisite/demo-data.ts`)
seeds a fictional company ("Northstar Engineering Ltd") with fictional
suppliers/sites and a full purchasing lifecycle including a genuinely
partial delivery. **Never called from production boot** - only from its
own test and any future explicit dev-seed script.

## Upgrade/migration notes

Requisite's schema (migration 0033) is additive-only relative to Core
P0-P2 - it introduces new `requisite_*` tables and touches no existing
Core table. Installing Requisite on an existing Core P0-P2 deployment
requires only running migration 0033 and registering the app manifest
(both already exercised by the full-suite clean-DB migration test).

## Known v1 limitations (see docs/decisions/REQUISITE-V1-DEVIATIONS.md for the full list)

Not yet wired: Files/attachments, Notifications, delivery-monitoring
reminders, the PO PDF document, custom field definitions, dedicated HTTP
routes for submit/approve/issue/generate-PO/record-receipt, and
multi-currency conversion. Explicitly deferred per item 45 (not
overbuilding v1): supplier self-service portal, procurement auctions, AI
supplier selection, accounts payable, inventory, asset lifecycle,
contract management, complex tendering, OCR invoice ingestion, corporate
card management, expenses, budget management.
