# Hexyrn Requisite - Administrator Guide (P3 item 42)

For the administrator configuring Requisite after it has been licensed and
enabled (see `docs/OPERATOR_GUIDE.md` §8 for licence import). Assumes
Hexyrn Core is already installed and bootstrapped.

## Licence

`Administration -> Applications -> Requisite -> Licence`. Shows licence
validity, licensed major version, support-expiry status, and Core
compatibility independently - a perpetual licence keeps Requisite fully
working even with expired support (see `docs/OPERATOR_GUIDE.md` §8).

## Permissions

Grant these to roles via Core's Roles admin screen (`requisite.manifest.ts`
is the source of truth for exact names):

| Permission | Grants |
|---|---|
| `requisite.suppliers.view` / `.manage` | View / create-edit suppliers |
| `requisite.requisitions.view` | View requisitions |
| `requisite.requisitions.create` | Create/edit draft requisitions |
| `requisite.requisitions.submit` | Submit a requisition for approval |
| `requisite.requisitions.approve` | Act as an approver in the approval chain |
| `requisite.requisitions.cancel` | Cancel a requisition |
| `requisite.purchase-orders.view` | View purchase orders |
| `requisite.purchase-orders.create` | Generate a PO from an approved requisition |
| `requisite.purchase-orders.issue` | Issue a generated PO to the supplier |
| `requisite.goods-receipts.view` / `.create` | View / record goods receipts |
| `requisite.rfqs.manage` | Create RFQs, record and select quotes |
| `requisite.reports.view` | Run Requisite's registered reports |

A typical role set: **Requester** (`requisitions.view/create/submit`),
**Approver** (adds `requisitions.approve`), **Purchasing** (adds
`purchase-orders.*`, `rfqs.manage`, `suppliers.manage`), **Goods Receiver**
(adds `goods-receipts.create`). Self-approval is blocked server-side - an
approver acting on their own requisition is rejected regardless of
permissions held.

## Approval routing

Configured through Core's normal declarative Workflow/Approval definition
mechanism (not hardcoded) - see `docs/REQUISITE.md`'s Workflow section for
the default `requisition-lifecycle` state machine
(`draft -> submitted -> awaiting_approval -> approved -> ordered ->
partially_received -> received -> closed`, plus `rejected`/`cancelled`).
Adjusting approval chains/thresholds is a Core Workflow administration
task, not a Requisite-specific screen.

## Numbering

Requisitions, purchase orders, and goods receipts use Core's numbering-
sequence mechanism (configurable prefix/padding per entity type) rather
than raw UUIDs in any user-facing screen - see Core's Numbering admin
screen.

## Categories / custom fields / forms

Requisition line categories and any organisation-specific custom fields
are configured through Core's Custom Fields and Forms admin mechanisms
(JSONB-backed, type-aware query support - see `docs/ARCHITECTURE.md` §2),
scoped to the `requisite.requisition` entity type. Not a Requisite-specific
schema - the same mechanism every Core app uses.

## Supplier import

Bulk supplier creation uses Core's Import Framework (CSV-based,
`ImportHandlerRegistryService` - see `docs/REQUISITE.md`) rather than a
Requisite-specific bulk-upload screen.

## Notifications

Requisition submission/approval/rejection/PO-issuance events route through
Core's Notification framework (in-app + email channel, per-user
preferences) - see `docs/OPERATOR_GUIDE.md` §3 for SMTP setup; without
SMTP configured, in-app notifications still work and invitation/reset
links are shared manually.

## Delivery reminders

`apps/api/src/apps/requisite/delivery-monitoring.service.ts` runs as a
scheduled background job (Core's job scheduler) checking for overdue
expected-delivery dates on issued POs and raising a notification - no
separate configuration screen; the check interval is a deployment-level
setting, not yet exposed in an admin UI.

## Reporting

`Administration -> Requisite -> Reports` (also reachable from the
Requisite navigation for users with `requisite.reports.view`) - lists and
runs Requisite's registered report templates through Core's generic
report interface (`GET/POST /api/v1/reports`), permission-checked
identically to any other Core report.
