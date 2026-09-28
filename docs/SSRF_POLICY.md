# Outbound network policy / SSRF hardening (P3 item 34/12)

## What is protected

Every outbound HTTP call this codebase makes to an administrator-configured
URL goes through `apps/api/src/security/outbound-network-policy.ts`
(confirmed the only real outbound HTTP call site by grepping for `fetch(`
across `src/` - the integration/sync connector framework does not yet make
real outbound calls, see `docs/decisions/P2-DEVIATIONS.md`). Today that is
webhook delivery (`apps/api/src/platform/webhooks/webhook-sender.ts`).

## Design: explicit policy, not a blanket prohibition

Hexyrn is self-hosted. A customer's own webhook receiver may legitimately
live on their internal network - blindly prohibiting every private-network
destination would break a real, legitimate use case. The policy is
therefore:

- **Default (safe):** loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16,
  fe80::/10 - this range includes the cloud metadata service address
  169.254.169.254 used by AWS/GCP/Azure to serve instance credentials, not
  special-cased separately since it's already link-local space), private
  IPv4 (10/8, 172.16/12, 192.168/16), private IPv6 (unique local addresses,
  fc00::/7), and multicast/reserved ranges are all **blocked**.
- **Administrator opt-in:** `HEXYRN_OUTBOUND_ALLOWED_HOSTS` (comma-separated
  hostnames or IP literals) explicitly permits specific destinations even
  if they fall in a blocked range - a narrow, per-destination exception,
  not a global "allow all private networks" toggle.

## DNS rebinding

The policy resolves a hostname to its actual IP address and validates
_that_, not the hostname string. This check runs on **every request and
every redirect hop** (not once at webhook-registration time) - a hostname
that currently resolves to an allowed address could later resolve to an
internal one, and re-checking per-request is what closes that gap.

## Redirects

`HttpWebhookSender` uses `fetch(..., { redirect: 'manual' })` and
independently re-validates every `Location` header through the same policy
before following it, capped at 3 hops. Without this, a validated initial
URL could redirect to an internal address after the check has already
passed - proven by a real test using a local HTTP server that redirects to
a private address, confirming the second hop is rejected even though the
first hop was allowed.

## Configuration

```
HEXYRN_OUTBOUND_ALLOWED_HOSTS=192.168.1.50,erp.internal.example.com
```

Leave unset for the safe default (no exceptions).

## Test coverage

- `apps/api/src/security/__tests__/outbound-network-policy.spec.ts` (20
  tests): every blocked range, literal-IP handling, real DNS resolution
  (no mocking - a real lookup against a stable public hostname, and
  against `localhost` to confirm it resolves to loopback and is blocked),
  the allow-list mechanism, and env-var parsing.
- `apps/api/src/platform/webhooks/__tests__/webhook-sender-ssrf.spec.ts`
  (5 tests): a real local `http.Server`, real `fetch()` calls, proving
  delivery succeeds to an allowed destination, is refused to a
  non-allowed one, follows a redirect to another allowed destination,
  refuses to follow a redirect to a blocked destination even though the
  initial URL was allowed, and caps a redirect loop rather than hanging.

## What is NOT yet covered

- The integration/sync-connector framework does not make real outbound
  HTTP calls yet (P2-era deviation, unrelated to this hardening pass) - it
  will need to route through this same policy module once it does.
- No admin UI surfaces `HEXYRN_OUTBOUND_ALLOWED_HOSTS` for editing - it is
  an environment variable today, consistent with how other installation-
  level secrets/config are handled in this phase.
