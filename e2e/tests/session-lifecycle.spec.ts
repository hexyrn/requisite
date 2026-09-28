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
