# ADR 0007: CSRF check exempts `@PublicRoute()` handlers regardless of session state

## Status

Accepted (Requisite v1 UI phase, 2026-09-22). Signed off by the user as a
legitimate Core correction exposed by real product usage, not a weakening
of CSRF protection.

## The bug

Architecture §6's synchronizer-token CSRF design requires a valid
`X-Hexyrn-CSRF` header on every state-changing (`POST`/`PUT`/`PATCH`/
`DELETE`) cookie-authenticated request. `SessionAuthGuard`
(`apps/api/src/http/session-auth.guard.ts`) implements this, but its
original logic applied the CSRF check whenever it successfully resolved
an active session from the request's cookie - **including on
`@PublicRoute()` handlers**, such as `POST /auth/login` and the bootstrap
endpoints.

This meant: an already-authenticated user (still holding a valid session
cookie - e.g. a second browser tab, or navigating back to `/login` without
logging out) who re-submitted the login form got a hard "Missing or
invalid CSRF token" 401, because the login form is `@PublicRoute()` and,
by design, has never been issued a CSRF token to send (the token is only
minted and handed to the SPA _by_ a successful login/MFA response - see
Architecture §6, "delivered to the SPA once"). This was found during
manual accessibility/responsive testing of Requisite v1's UI (not a
theoretical review finding) and reproduced reliably against the real
backend.

## Why this is a legitimate Core fix, not a Requisite workaround

Login/bootstrap are marked `@PublicRoute()` specifically _because_ they
are not behind the CSRF gate - `PUBLIC_ROUTE_KEY`'s whole purpose (per the
guard's own doc comment) is "routes must opt OUT via `@PublicRoute()`
... rather than opting in - deny-by-default" for the _authentication_
requirement. The CSRF check is logically a sub-concern of "this route
requires an authenticated session and it's mutating," which a
`@PublicRoute()` handler has already declared it is not subject to. The
guard's CSRF branch not checking `isPublic` was an oversight in how the
two independent gates (auth-required, CSRF-required) were composed - the
fix aligns the CSRF check with the same `isPublic` flag that already
governs the authentication requirement, rather than introducing any new
concept.

## The fix

`apps/api/src/http/session-auth.guard.ts`:

```ts
const mutating = !isPublic && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
if (mutating) {
  /* ...CSRF header check, unchanged... */
}
```

One line changed: the CSRF check is now `!isPublic && <mutating method>`
instead of just `<mutating method>`.

## What did NOT change (confirming no weakening)

- Every **non**-public, authenticated, mutating route (the overwhelming
  majority of the API surface - logout, every Requisite route, every
  admin route, etc.) still requires the `X-Hexyrn-CSRF` header exactly as
  before. `isPublic` is `false` for all of them, so `mutating` evaluates
  identically to the pre-fix logic.
- The synchronizer-token mechanism itself (server-side token bound to the
  session record, compared byte-for-byte, never a second cookie) is
  unchanged.
- `@PublicRoute()` handlers were **already** unauthenticated-request-
  reachable by definition (that is what the decorator means) - this fix
  does not newly expose them to anything; it only removes a spurious
  401 that fired _in addition to_ the route already being public, and
  only in the specific case where a session cookie happened to already
  be present.
- GET requests were never subject to the CSRF check (unchanged, still
  correct per Architecture §6).

## Regression tests

`apps/api/src/__tests__/http-e2e.integration.spec.ts`, `describe('CSRF
(synchronizer-token pattern, Architecture §6)')`:

- **New:** `'re-submitting login while an existing valid session cookie is
present succeeds without a CSRF header (public route, regression)'` -
  logs in twice with the same agent/cookie jar, second `POST
/auth/login` sent with no `X-Hexyrn-CSRF` header, asserts `201` (was
  `401` before the fix).
- **New:** `'a non-public authenticated mutating route still requires CSRF
even after the public-route fix'` - logs in, then `POST /auth/logout`
  (not `@PublicRoute()`) with no CSRF header, asserts `401` with a
  CSRF-mentioning message - proves the fix is scoped exactly to public
  routes and does not touch protection for anything else.
- Pre-existing tests in the same `describe` block (missing token rejected,
  wrong token rejected, another session's token rejected, correct token
  accepted, GET exempt) continue to pass unmodified, confirming the fix
  is additive/narrowing, not a relaxation of the general rule.

Verified clean (single, non-concurrent run against real Postgres):
`http-e2e.integration.spec.ts` - all CSRF/session tests pass, including
both new regression tests.

## Consequences

None beyond the fix itself - no schema change, no new config, no new
dependency. `apps/web/src/api/client.ts`'s CSRF-token handling (only
attaches the header when a token is held in memory) was already correct
and needed no change; the bug was entirely server-side.
