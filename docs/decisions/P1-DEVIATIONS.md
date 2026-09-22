# P1 Deviations from Architecture v1.0

No architecture contradictions were found during P1 implementation - every
item in the P1 brief was buildable within Architecture v1.0 as written.
This file records the same kind of thing `P0-DEVIATIONS.md` does:
transparency about where an implementation choice fell short of the full
architectural ideal, even though it wasn't a contradiction requiring
architecture review.

## Named, documented simplifications (each has its own ADR)

- **App licensing signature verification** - `docs/decisions/0004-app-licensing-simplification.md`.
  P1 records a license without real asymmetric signature verification.
  Explicitly flagged there as required pre-commercial-launch work, not
  optional polish - `grantLicense` is not exposed via any HTTP endpoint in
  P1, so there is no attacker-facing surface depending on it yet.
- **Cross-organisation background work enumeration** - `docs/decisions/0005-cross-org-background-enumeration.md`.
  Not a simplification so much as a genuinely new mechanism the
  architecture doesn't specify in this much detail; recorded as an ADR
  because it's a real design decision (a non-RLS routing table) that
  future readers should understand the reasoning for.

## Explicitly out of scope, per the P1 task brief itself

- **Admin-assisted MFA reset** (Architecture §6, P0's tracked debt): the P1
  brief said to implement it "if it naturally fits the Users & Access
  administration work, otherwise keep explicitly tracked for pre-
  commercial hardening." P1 did not touch Users & Access administration
  UI/endpoints at all (P1's scope was the platform mechanisms, not P0
  feature completion), so this remains tracked, not implemented.
- **Event payload schema validation**: `EventPublisherService.publish`
  accepts any `Record<string, unknown>` payload with no schema check
  against the publishing app's `eventsPublished` declaration. All P1
  callers are Core's own or the reference app's own TypeScript code (never
  raw HTTP request bodies), so this is a real but currently low-risk gap -
  a genuinely malicious payload would have to originate from trusted,
  already-authenticated application code, not an external caller. Tracked
  as technical debt (see the final P1 report), not fixed in P1: closing it
  properly means adding a JSON-schema-per-event-type concept to the
  manifest contract, which is new API surface, not a bug fix.

## Not a deviation, but worth stating explicitly

**Capability/app registration is not exposed via any HTTP endpoint in
P1.** This is intentional, not an oversight: Architecture §3's v1 packaging
model is "apps are workspace packages compiled into one build," so
registration is a boot-time action (`registerApp` called from `main.ts`
for every compiled-in app), never something a runtime caller triggers.
There is therefore no "malicious app registration via HTTP" attack surface
to defend against in P1 - the concern the P1 security review item names
("malicious/invalid app registration") doesn't have a runtime instance
yet, since only code already compiled into the build can register
anything. This will need re-examination if/when the "near-future
evolution" packaging model from Architecture §3 (independently
distributed, signed app packages fetched at deploy time) is ever built.
