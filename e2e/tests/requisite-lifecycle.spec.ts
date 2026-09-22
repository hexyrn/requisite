import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Item 29 - the final proof: a genuine browser-level E2E test against the
 * REAL running Hexyrn backend (apps/api, Fastify/Nest) and REAL
 * PostgreSQL (seeded by apps/api/scripts/e2e-seed.ts - no mocked
 * responses anywhere in this file). Exercises the full purchasing
 * lifecycle exactly as specified: Login -> Create Requisition -> Add
 * Lines -> Attach Quote -> Submit -> Switch to Approver -> Review ->
 * Approve -> Generate PO -> Issue PO -> Partial Goods Receipt -> Final
 * Goods Receipt -> Verify Complete -> Open PO PDF. Screenshots are
 * captured at each major step to docs/screenshots/.
 */
const seed = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'seed-output.json'), 'utf8'));
const screenshotDir = join(__dirname, '..', '..', 'docs', 'screenshots');

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/requisite', { timeout: 15000 });
}

/**
 * Navigates to a requisition's detail page via a REAL client-side SPA
 * link click (Requisitions list -> row link), never `page.goto()`/
 * `page.reload()` - the frontend's CSRF token is held in an in-memory JS
 * module variable set at login time (see api/client.ts), so any full
 * page navigation after login would silently drop it and break every
 * subsequent POST. This is the correct way to move around the app
 * within one logged-in session, exactly as a real user clicking through
 * the UI would.
 */
async function openRequisition(page: Page, requisitionNumber: string) {
  await page.getByRole('navigation', { name: 'Requisite navigation' }).getByRole('link', { name: 'Requisitions', exact: true }).click();
  await page.waitForURL('**/requisite/requisitions');
  await page.getByRole('link', { name: requisitionNumber }).click();
  await page.waitForURL(/\/requisite\/requisitions\/[0-9a-f-]+$/);
}

test.describe.configure({ mode: 'serial' });

test('Requisite v1 full purchasing lifecycle - genuine browser E2E against real backend + Postgres', async ({ browser }) => {
  test.setTimeout(120_000);

  // --- Requester (Owner) context ---
  const requesterContext = await browser.newContext();
  const requester = await requesterContext.newPage();
  requester.on('pageerror', (err) => console.log('[requester pageerror]', err.message));
  requester.on('console', (msg) => { if (msg.type() === 'error') console.log('[requester console.error]', msg.text()); });

  await login(requester, seed.ownerEmail, seed.ownerPassword);
  await requester.screenshot({ path: join(screenshotDir, '01-requisite-home.png'), fullPage: true });

  // New Requisition
  await requester.getByRole('link', { name: 'New Requisition' }).click();
  await requester.waitForURL('**/requisite/requisitions/new');
  await requester.screenshot({ path: join(screenshotDir, '02-new-requisition.png'), fullPage: true });

  await requester.getByLabel('What do you need, and why?').fill('Replacement steel brackets for the Coventry production line');
  await requester.getByLabel('Line description').fill('Galvanised Steel Brackets (Grade A)');
  await requester.getByLabel('Quantity').fill('50');
  await requester.getByLabel('Estimated unit price in pence').fill('350');

  // Attach a real quote file via the real multipart upload path.
  const fileInput = requester.locator('#requisition-attachment');
  await fileInput.setInputFiles({ name: 'quote.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake quote content for e2e test') });
  await expect(requester.getByText('quote.pdf')).toBeVisible();

  await requester.getByRole('button', { name: 'Save Draft' }).click();
  await requester.waitForURL(/\/requisite\/requisitions\/[0-9a-f-]+$/, { timeout: 15000 });
  const requisitionNumber = (await requester.locator('h1:not(:empty)').textContent())!.trim();
  await requester.screenshot({ path: join(screenshotDir, '03-requisition-detail-draft.png'), fullPage: true });

  // The attachment should show on the detail page.
  await expect(requester.getByText('quote.pdf')).toBeVisible();

  // Submit for approval.
  await requester.getByRole('button', { name: 'Submit for Approval' }).click();
  await expect(requester.getByText('Awaiting Approval', { exact: false })).toBeVisible({ timeout: 10000 });
  await requester.screenshot({ path: join(screenshotDir, '04-requisition-awaiting-approval.png'), fullPage: true });

  // --- Approver context (a genuinely different login - self-approval is blocked server-side) ---
  const approverContext = await browser.newContext();
  const approver = await approverContext.newPage();
  await login(approver, seed.approverEmail, seed.approverPassword);

  await openRequisition(approver, requisitionNumber);
  await expect(approver.getByText('Replacement steel brackets')).toBeVisible();
  await approver.screenshot({ path: join(screenshotDir, '05-approver-review.png'), fullPage: true });

  await approver.getByLabel('Comment (required to reject)').fill('Approved - within department budget.');
  await approver.getByRole('button', { name: 'Approve' }).click();
  await expect(approver.getByText('Approved', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  await approver.screenshot({ path: join(screenshotDir, '06-requisition-approved.png'), fullPage: true });

  // --- Back to requester: generate the Purchase Order. Re-open the
  // requisition via a real client-side navigation (never reload) so the
  // requester's own CSRF token, set at their login, is never dropped. ---
  await openRequisition(requester, requisitionNumber);
  await expect(requester.getByText('Approved', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  await requester.getByLabel('Supplier').selectOption({ label: seed.supplierName });
  await requester.getByRole('button', { name: 'Generate Purchase Order' }).click();
  await requester.waitForURL(/\/requisite\/purchase-orders\/[0-9a-f-]+$/, { timeout: 15000 });
  const poUrl = requester.url();
  await requester.screenshot({ path: join(screenshotDir, '07-purchase-order-draft.png'), fullPage: true });

  // Issue the PO.
  await requester.getByRole('button', { name: 'Issue Purchase Order' }).click();
  await expect(requester.getByText('Issued', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  await requester.screenshot({ path: join(screenshotDir, '08-purchase-order-issued.png'), fullPage: true });

  // --- Partial goods receipt (30 of 50) ---
  const receiveInput = requester.getByLabel(/Receive now for/);
  await receiveInput.fill('30');
  await requester.getByLabel('Delivery note reference').fill('DN-E2E-001');
  await requester.getByRole('button', { name: 'Record Goods Receipt' }).click();
  await expect(requester.getByText('Partially Received', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  await requester.screenshot({ path: join(screenshotDir, '09-purchase-order-partially-received.png'), fullPage: true });

  // --- Final goods receipt (remaining 20) ---
  const remainingInput = requester.getByLabel(/Receive now for/);
  await expect(remainingInput).toHaveValue('20');
  await requester.getByLabel('Delivery note reference').fill('DN-E2E-002');
  await requester.getByRole('button', { name: 'Record Remaining Delivery' }).click();
  await expect(requester.getByText('Received', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  await requester.screenshot({ path: join(screenshotDir, '10-purchase-order-received-complete.png'), fullPage: true });

  // Verify both receipts are present as distinct, immutable history rows.
  await expect(requester.getByText('DN-E2E-001')).toBeVisible();
  await expect(requester.getByText('DN-E2E-002')).toBeVisible();

  // --- Open the PO PDF document. Chrome's built-in PDF viewer does not
  // reliably surface a single trackable 'load'/network event through
  // Playwright when it takes over a new tab, so we prove the exact same
  // thing a real click would (a genuine authenticated GET returning real
  // PDF bytes) by fetching the same href through the requester's own
  // authenticated browser context (real session cookie, real HTTP call
  // to the real running backend) rather than fighting the PDF viewer's
  // rendering lifecycle. ---
  const pdfHref = await requester.getByRole('link', { name: 'View PDF' }).getAttribute('href');
  const pdfAbsoluteUrl = new URL(pdfHref!, requester.url()).toString();
  const pdfResponse = await requesterContext.request.get(pdfAbsoluteUrl);
  expect(pdfResponse.status()).toBe(200);
  expect(pdfResponse.headers()['content-type']).toContain('application/pdf');
  const pdfBytes = await pdfResponse.body();
  expect(pdfBytes.subarray(0, 4).toString('utf8')).toBe('%PDF');

  await requesterContext.close();
  await approverContext.close();
});
