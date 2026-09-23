# Rate limiting production readiness (P3 item 12)

## Current design: in-process, single-process

`apps/api/src/security/rate-limits.ts` / `account-rate-limiter.ts` use
`InMemoryRateLimitStore` - counts held in the Node process's own memory,
not a shared store (Redis, Postgres, etc.). This is a deliberate choice
for v1, not an oversight: **Hexyrn Core v1 is documented and designed as a
single-process deployment** (one Node process, one Postgres). Nothing in
the architecture requires horizontal scaling for the target self-hosted
SME customer size this product is built for.

## Why this matters operationally

**Do not run more than one API process for the same installation** while
this remains true, or rate limiting (and nothing else - sessions,
permissions, and all data access are correctly Postgres-backed and
already safe across multiple processes) silently becomes per-process
rather than global. Two processes each individually enforcing "10 login
attempts per 15 minutes" effectively allows 20 - not a security collapse
(Argon2id password hashing, account lockout via `AuthService`, and audit
logging are all still fully enforced and are NOT in-memory), but a real,
worth-stating limitation of the rate-limiting layer specifically.

- **Docker**: `docker-compose.yml` and any future production compose file
  must run exactly one replica of the application container. Do not set
  `deploy.replicas > 1` for the API service.
- **Windows service**: the installer (P3 item 3, in progress) must
  register exactly one service instance.
- **Behind a load balancer**: if a customer ever puts Hexyrn behind a
  load balancer for TLS-termination or other reasons, it must still route
  100% of traffic to a single backend instance - not for rate-limiting
  reasons alone but because this is the deployment model actually built
  and tested.

## The storage interface remains replaceable

`RateLimitStore` (`security/rate-limit-store.ts`) is an interface, not a
concrete dependency baked into `AccountRateLimiter` - `InMemoryRateLimitStore`
is the only implementation today, but swapping in a Redis- or
Postgres-backed store later (if a genuine multi-process/horizontally-scaled
deployment model is ever built) is a new class implementing the same
interface, not a rewrite of the rate-limiting logic itself.

## Why not just add Redis now

Adding a Redis dependency (and the operational burden of running,
securing, and backing up a second stateful service) solely to distribute
rate-limit counters that don't otherwise need distributing would be
exactly the kind of premature infrastructure this project's engineering
principles reject - real architectural need should drive the decision, not
defensive box-ticking. If/when Hexyrn Core genuinely needs multi-process
scaling (for throughput, not for rate limiting specifically), that's the
point to revisit this, and the interface is already shaped to make that
swap cheap.
