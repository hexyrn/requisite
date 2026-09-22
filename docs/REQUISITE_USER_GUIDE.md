# Hexyrn Requisite - User Guide (P3 item 43)

Role-based guidance for using Requisite day to day. Screens referenced
below are the real, shipped UI (see `docs/screenshots/` for genuine
captures from the Playwright E2E run of the actual application).

## Requester

1. **Home** (`docs/screenshots/01-requisite-home.png`) shows your draft
   requisitions and anything awaiting your action.
2. **New Requisition** (`02-new-requisition.png`): describe what you need
   and why, add one or more lines (description, quantity, unit, estimated
   unit price), optionally attach a supporting document (quote,
   specification - real file upload, 25MB limit). Category and
   cost-reference fields are optional, tucked under "More details."
3. Save as a draft, review it (`03-requisition-detail-draft.png`), then
   **Submit for Approval** when ready - this locks the requisition into
   the approval workflow; further edits require the approver to reject it
   back to you first.
4. Track status on the Requisitions list or the detail screen
   (`04-requisition-awaiting-approval.png`) - status is shown as a
   labelled badge (never colour alone, for accessibility).

## Approver

1. Your **Home** screen's "Awaiting my approval" section lists
   requisitions needing your decision
   (`05-approver-review.png`).
2. Review the summary and line items, then **Approve** or **Reject**.
   Rejecting requires a comment explaining why (required field, enforced
   before submission) - the requester sees this when the requisition comes
   back to them.
3. You cannot approve your own requisition, even if you hold the approval
   permission - this is enforced by the server, not just hidden in the UI.
4. Once approved (`06-requisition-approved.png`), the requisition becomes
   available for Purchasing to generate a Purchase Order from.

## Purchasing user

1. From an approved requisition, **Generate Purchase Order**, selecting
   the supplier (`07-purchase-order-draft.png`). The PO starts as a Draft.
2. **Issue** the PO (`08-purchase-order-issued.png`) once ready to send to
   the supplier - a real PDF is generated (**View PDF**) for you to send.
3. **Quotes/RFQs**: create an RFQ for a requisition, record quotations
   received from one or more suppliers side by side (the comparison table
   never auto-recommends a winner - selecting a quote is always your
   explicit action), then select or reject each quote.
4. **Suppliers**: view/add suppliers (name, email, status).

## Goods receiver

1. Open the relevant **Purchase Order**, use **Receive Now**
   (`09-purchase-order-partially-received.png`) to record quantities
   actually received against each line - partial receipts are fully
   supported (Outstanding column tracks what's left).
2. Once every line's outstanding quantity reaches zero, the PO shows
   **Received** (`10-purchase-order-received-complete.png`) and its full
   Goods Receipt History is visible on the same screen.

## Reports

Anyone with report-view permission can run Requisite's registered reports
from **Reports** in the navigation - results render as a table; no report
requires an active support entitlement to run (only the underlying view
permission on the report's own dataset).

## Accessibility

Every screen above has been manually verified for keyboard navigation
(visible focus outlines throughout), labelled form controls (including
dynamically-added line-item rows), and responsive layout at tablet width
(768px) - see the Requisite UI phase's completion report for the specific
issues found and fixed (a line-item grid overflow, an off-screen
validation-error banner) during that pass.
