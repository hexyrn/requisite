# Development Status and Handoff

Last updated: 2026-09-28. Read this first; it supersedes the "what remains" lists in
`P3-FINAL-INTERIM-REPORT.md` and `P3-ENVIRONMENT-VERIFICATION.md` where they differ, and those two files remain the
detailed record of P3 verification.

## What this is

Hexyrn Core (auth, organisations, RBAC + row-level security, audit, workflow, files, reporting, backup/restore, update,
licensing, admin screens) plus **Requisite** (requisitions, RFQs, purchase orders, goods receipts, suppliers, reports)
as the first business app. NestJS + Fastify API, React + Vite SPA, PostgreSQL 17, Kysely with hand-written SQL migrations.

**Formal status: P3 RELEASE ACCEPTANCE PENDING** (unchanged). Everything that can be proven without a clean Windows
VM, a real GitHub Actions runner, or a business/legal decision has been proven; see "Blocked" below.

## Verified state (this session, from a clean `npm ci`)

| Check                                                           | Result                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run build` / `typecheck` / `lint`                          | pass (1 pre-existing warning: unused `_signingKeyId` in `release-verifier.ts`)                               |
| Backend Jest (`apps/api`)                                       | **68/68 suites, 498/498 tests**, on Node 22 and on **Node 20.20.2**                                          |
| Web Vitest                                                      | **26/26 tests** in 6 files                                                                                   |
| Playwright E2E (`e2e/`)                                         | **3/3**: full purchasing lifecycle + 2 new session-lifecycle tests, also under the exact env the CI job uses |
| Migrations                                                      | 33 apply to an empty DB; second run is a no-op                                                               |
| `npm audit --omit=dev`                                          | **0 vulnerabilities** (was 1 critical / 4 high / 7 moderate)                                                 |
| `prettier --check` (CI step 1)                                  | pass (was failing on 160 files)                                                                              |
| Built API booted on Node 20 as the restricted `hexyrn_app` role | health, bootstrap, login, CSRF, origin check, cookie flags verified by hand                                  |

**Not re-verified this session:** Docker (no daemon in the sandbox), the Windows installer, and anything needing
Windows. This sandbox ran **PostgreSQL 16**, not 17; migrations, RLS, role split (via the project's own
`docker/postgres-init/01-app-role.sh`) and the whole test suite pass on 16, but 17 remains verified only by the earlier
Docker round.

## What changed this session

**Security**

- **MFA bypass fixed (critical).** `SessionAuthGuard` never checked `mfa_verified`, so a password-only session for an
  MFA-enrolled user was accepted everywhere; the second factor could be skipped by not calling `/auth/mfa/verify`.
  Guard now rejects `user.mfa_enabled && !session.mfaVerified` except public routes and `@AllowPreMfa()` (logout).
  `login` now records `mfa_verified = !user.mfa_enabled` (it was always `false`). Confirming enrolment marks the
  enrolling session verified. Tests: bypass attempt, pre-MFA logout, no self-lockout after enrolment.
- **Logout never revoked the server session.** The SPA sent `Content-Type: application/json` with no body; Fastify
  returns 400; the UI redirected to `/login` anyway. Same bug broke every body-less POST from the UI.
- **Dependency remediation** (`docs/DEPENDENCY_REMEDIATION.md`, updated): NestJS 11.2.6, Fastify 5.12.5, Kysely 0.28.17,
  React Router 7.18.4, etc. NestJS 12 / Kysely 0.29 are ESM-only, so the CommonJS-compatible fixed lines were chosen.

**Correctness / UX**

- Page refresh lost the in-memory CSRF token, so every save failed until re-login (the old E2E test worked around this
  by never reloading). New `GET /api/v1/auth/session` returns the caller's own CSRF token; the shell restores it.
- Logged-out visitors got a blank page; now redirected to `/login`; nothing protected renders until the session is
  confirmed. Favicon added (was a 404 on every load).

**Test / CI reliability**

- `http-e2e` restored a stale `process.env` snapshot after the key-rotation block, re-enabling Secure cookies and making
  later tests fail with "No session"; it now restores only the keys it changes, and resets the process-wide login rate
  limiters per test (the file sits at the 30/15 min per-IP ceiling).
- `jest.setup.js` supplies test-only encryption keys when unset, so the suite runs from a fresh checkout.
- `e2e-seed.ts` created no `e2e/fixtures/`; `playwright.config.ts` accepts `E2E_CHROMIUM_PATH`.
- Prettier applied repo-wide as its own commit (mechanical, verified no behaviour change).
- New `e2e/tests/session-lifecycle.spec.ts` (mutation-checked: fails with the original 400 if the header bug returns).

## Decisions made

1. Stay CommonJS. Do not adopt NestJS 12 / Kysely 0.29 until the backend is deliberately converted to ESM (Jest ESM
   support, `.js` import specifiers, native modules such as argon2 all need review). Pins: `@fastify/cookie ~10.0.1`
   (11.x uses a dynamic `import()` Jest cannot run), `kysely ~0.28.17`, `overrides.fastify 5.12.5`, `overrides.uuid ^11.1.1`.
2. MFA state is enforced on the _user's_ `mfa_enabled` plus the session flag, not the flag alone, so sessions that
   predate the fix (all stored `mfa_verified=false`) keep working for users without MFA.
3. `GET /auth/session` exposes the CSRF token to the authenticated caller only; pre-MFA sessions are refused by the guard.
4. Dev-tool advisories (Vite/Vitest) deferred to the Node 22 migration because Vitest 5 requires Node >= 22.12.

## Running things locally

```bash
npm ci
# Postgres with a non-superuser owner role `hexyrn` (see docs/SETUP.md / .env.example); then:
export TEST_DATABASE_URL=postgres://hexyrn:<pw>@localhost:<port>/hexyrn_core_test
npm test                              # backend (skips DB suites, loudly, if TEST_DATABASE_URL is unset)
npm run test --workspace apps/web
# Browser E2E: needs API on :3000 and web on :5173 with ALLOWED_ORIGINS=http://localhost:5173, COOKIE_SECURE=false
DATABASE_URL=... npx ts-node apps/api/scripts/e2e-seed.ts   # re-seed before EVERY run: the lifecycle test needs a fresh DB
npm run test --workspace e2e          # set E2E_CHROMIUM_PATH to use a pre-installed Chromium
```

Browse the UI at `http://localhost:5173`, not `127.0.0.1`: the API's origin allow-list rejects other origins
(`ORIGIN_NOT_ALLOWED`), which is correct behaviour.

## Known limitations / open items

- **Blocked on environment/decision (unchanged):** Windows installer install/uninstall/upgrade on a clean VM, code
  signing, custom uninstall checkbox UI, real GitHub Actions run of `release-pipeline.yml`, Let's Encrypt ACME path,
  legal/privacy documents, and the first-customer RC declaration.
- **The CI pipeline has still never run on a real runner.** This session removed two failures it would have hit on
  first run (prettier, `npm audit`) and simulated the migration and E2E jobs locally, but treat its first real run as
  untested.
- **Node 20 is out of upstream maintenance** and is what CI, both Dockerfiles and the Windows installer target.
- Vite/Vitest dev-tooling advisories (above). Not shipped to customers.
- Frontend test coverage is thin (26 tests); the browser E2E suite carries most UI confidence. `LoginPage`,
  `MfaChallengePage` and the admin screens have no component tests.
- Login/MFA UI was not exercised in a browser with an MFA-enrolled account (the API side is covered by tests).
- Rate-limit stores are in-memory (single process) by design; documented in `docs/RATE_LIMITING.md`.
- Deep circular-FK restore (`organisational_units`, `locations`) remains unexercised, per earlier notes.

## Recommended next tasks (in order)

1. Run `release-pipeline.yml` for real on GitHub (push the branch, watch every job) and fix whatever it finds.
2. Node 20 -> 22 migration as one change: Dockerfiles, CI `NODE_VERSION`, installer Node artifact + pinned SHA-256,
   `engines`, then Vite 8 / Vitest 5 (closes the remaining audit findings).
3. Browser E2E for MFA login/enrolment and for the admin screens (health, backup, update, licence, SMTP, support bundle).
4. Clean-VM Windows acceptance test per `docs/WINDOWS_ACCEPTANCE_PREP.md`.
5. Legal/privacy surfaces (needs a business decision).
