# First-Run Bootstrap Flow

Hexyrn Core ships with no default organisation, no default admin account,
and no default password. The very first thing a fresh installation needs is
a way to create exactly one organisation and one owner account, securely,
without exposing that capability to anyone but the person who deployed it.

## What happens on first boot

1. The API checks whether an `installations` row exists. If not (this is
   the very first boot), it:
   - Creates the `installations` row (records the running Core version).
   - Generates a cryptographically secure random token (256 bits, see
     `apps/api/src/security/tokens.ts`).
   - Stores only a SHA-256 hash of the token in `bootstrap_tokens` - the
     plaintext token is never persisted anywhere.
   - Prints the plaintext token to stdout as both a structured log line and
     a clearly delimited block, and writes it to `bootstrap-token.txt` in
     the API process's working directory (file permissions restricted to
     the owner where the OS supports it; this file is gitignored and is
     never served over HTTP).
   - The token is **never emailed, never returned by any API response, and
     never written anywhere web-accessible by default.** Retrieving it
     requires access to the server's console output or filesystem - i.e.
     the deploying operator, not a remote client.

2. On every subsequent boot, this step is a no-op (the `installations` row
   already exists) - no new token is generated, and the setup flow below
   cannot be reopened even by an operator who still has the original token,
   because the token is single-use and is marked consumed inside the same
   database transaction that creates the organisation (see below), not
   afterwards.

## Completing setup

Visit the frontend's `/setup` page (or `POST /api/v1/bootstrap/complete`
directly) with:

- The plaintext token from step 1.
- Organisation name, display name, default currency, timezone, locale,
  financial year start month.
- The owner's email and password.

The server (`BootstrapService.completeBootstrap`, in
`apps/api/src/bootstrap/bootstrap.service.ts`) does all of the following in
a **single database transaction**, so it either all happens or none of it
does:

1. Atomically consumes the token: `UPDATE bootstrap_tokens SET consumed_at
= now() WHERE token_hash = $1 AND consumed_at IS NULL`. This update only
   ever succeeds for exactly one caller, even under concurrent requests -
   there is no separate "check then use" step that a race could exploit.
2. Creates the organisation.
3. Creates the owner user account (Argon2id-hashed password).
4. Creates an "Owner" role holding every Core P0 permission and assigns it
   to the new user.
5. Records a `bootstrap.completed` audit event.
6. Records the new organisation's id on the `installations` row (this is
   how the login endpoint later finds "the" organisation for this
   installation - P0's product behaviour is exactly one organisation per
   installation, per Architecture §7).

If the token is missing, already consumed, or doesn't match, the whole
transaction rolls back and nothing is created. **This is proven by an
automated test**
(`apps/api/src/bootstrap/__tests__/bootstrap.integration.spec.ts`) that
completes setup once, then asserts a second attempt with the same token is
rejected and that no second organisation was created.

## After setup

The bootstrap token is permanently invalid from this point on - there is no
administrative action that reopens the one-time setup flow. Further admin
users are created via the invitation flow
(`apps/api/src/auth/invitation.service.ts`), not by generating another
bootstrap token.
