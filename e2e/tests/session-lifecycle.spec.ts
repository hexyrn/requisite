import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Browser-level regression tests for session handling. Each of these was a
 * real bug that the mocked-fetch unit tests and the in-process Jest HTTP
 * tests could not see, because they only show up with a real browser talking
 * to the real server:
 *  - a logged-out visitor got a blank page instead of the login form;
 *  - the in-memory CSRF token was lost on reload, so every save afterwards
 *    was rejected until the user logged in again;
 *  - logout sent `Content-Type: application/json` with no body, which Fastify
 *    rejects with 400, so the server-side session was never revoked.
 */
const seed = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'seed-output.json'), 'utf8'),
);

test('logged-out visitors are sent to /login, not shown a blank page', async ({ page }) => {
  await page.goto('/requisite');
  await page.waitForURL('**/login');
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('a page reload keeps the session AND keeps state-changing requests working; logout really revokes the session', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(seed.ownerEmail);
  await page.getByLabel('Password').fill(seed.ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Open Requisite' }).click();
  await page.waitForURL('**/requisite');

  await page.reload();
  await expect(page).toHaveURL(/\/requisite$/);
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

  // Logging out after a reload is a state-changing (CSRF-protected) POST with
  // no body: it must succeed (201), which proves the token was restored.
  const logout = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/logout'));
  await page.getByRole('button', { name: 'Log out' }).click();
  expect((await logout).status()).toBe(201);
  await page.waitForURL('**/login');

  // The server session is genuinely dead, not just hidden by the redirect.
  await page.goto('/requisite');
  await page.waitForURL('**/login');
});

test('the suite launcher: Core hosts the apps, the switcher moves between them, and each app carries its own accent colour', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(seed.ownerEmail);
  await page.getByLabel('Password').fill(seed.ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Home = launcher, in Core's colour, listing the licensed app and (for the owner) Administration.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: 'Open Requisite' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Administration' })).toBeVisible();
  const accent = (p: typeof page) =>
    p.evaluate(() =>
      getComputedStyle(document.querySelector('.hx-topbar') as Element)
        .getPropertyValue('--hx-accent')
        .trim(),
    );
  const coreAccent = await accent(page);

  // Open the app: URL, top-bar title and accent all change.
  await page.getByRole('link', { name: 'Open Requisite' }).click();
  await page.waitForURL('**/requisite');
  await expect(page.locator('.hx-brand__app')).toHaveText('Requisite');
  const requisiteAccent = await accent(page);
  expect(requisiteAccent).toBe('#0f766e');
  expect(requisiteAccent).not.toBe(coreAccent);

  // Switch to Administration via the app switcher, then back Home.
  await page.getByRole('button', { name: 'Switch app' }).click();
  await page.getByRole('link', { name: /Administration/ }).click();
  await page.waitForURL('**/admin/**');
  await expect(page.locator('.hx-brand__app')).toHaveText('Administration');
  expect(await accent(page)).toBe(coreAccent);
  await page.getByRole('button', { name: 'Switch app' }).click();
  await page.getByRole('link', { name: /^Home/ }).click();
  await expect(page).toHaveURL(/\/$/);
});
