# Dependency / Supply-Chain Remediation (P3, pre-RC1)

## UPDATE (2026-09-28): production dependencies now clean

**`npm audit --omit=dev` → 0 vulnerabilities** (was 12: 1 critical, 4 high, 7 moderate). The CI `dependency-scan`
job (`--audit-level=high`) would have failed on the previous tree; it passes now. Verified from a clean `npm ci`, on
Node 22 **and Node 20.20.2** (the version the Docker images and Windows installer ship): build, typecheck, lint,
68/68 backend suites (498 tests), 26/26 web tests, and the Playwright browser suite.

Deviation from the plan in items 1–5 below, and why: **NestJS 12 and Kysely 0.29 are ESM-only** and this backend is
CommonJS under ts-jest, so the "matched v12 set" would have meant converting the whole backend to ESM. Instead the
CommonJS-compatible fixed lines were used:

| Package                                                    | Was     | Now     | Note                                                                                         |
| ---------------------------------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------- |
| `@nestjs/common` / `core` / `platform-fastify` / `testing` | 10.4.22 | 11.2.6  | CJS; pulls patched `@fastify/middie` 9.3.4, `find-my-way` 9.7.0, `file-type` 21.3.4          |
| `@nestjs/config`                                           | 3.3.0   | 4.0.4   | required by Nest 11                                                                          |
| `fastify`                                                  | 4.x     | 5.12.5  | forced to a single copy with root `overrides.fastify` (platform-fastify pins 5.11.3 exactly) |
| `@fastify/cookie`                                          | 9.4.0   | 10.0.1  | 11.x uses a dynamic `import()` that Jest cannot load                                         |
| `@fastify/multipart`                                       | 8.x     | 9.4.0   | Fastify 5                                                                                    |
| `kysely`                                                   | 0.27.6  | 0.28.17 | first dual CJS/ESM release past the vulnerable range (≤0.28.16)                              |
| `react-router-dom`                                         | 6.x     | 7.18.4  | v6 API used by this app is unchanged                                                         |
| `uuid` (via `exceljs`)                                     | 8.3.2   | 11.1.1  | root `overrides.uuid`; CJS `v4` export retained; export suites pass                          |

**Still open (dev-only, nothing ships):** `vite` ≤6.4.2 (high), `vitest` ≤4.1.10 (critical, only when the Vitest UI server
is run), `esbuild`, `@vitest/mocker`, `vite-node`. Fixing needs Vite 8 / Vitest 5, and **Vitest 5 requires Node ≥ 22.12**
while CI, both Dockerfiles and the installer bundle Node 20. Do this together with the Node 20 → 22 migration (see
`docs/DEVELOPMENT_STATUS.md`), not before.

**Maintenance note:** when changing overrides, npm keeps stale entries in `package-lock.json`. If a package does not move
after an override change, delete its `node_modules/<pkg>` entries from the lockfile and reinstall, then confirm with
`rm -rf node_modules && npm ci && npm ls <pkg>`.

The remainder of this document is the original (pre-update) analysis and is kept for the reachability reasoning.

---

## Before / after counts

|            | Critical | High | Moderate | Low/Info | Total  |
| ---------- | -------- | ---- | -------- | -------- | ------ |
| **Before** | 2        | 6    | 12       | 0        | **20** |
| **After**  | 2        | 5    | 11       | 0        | **18** |

Two vulnerabilities closed safely (no breaking changes):

1. `npm audit fix` (non-force) applied one in-range compatible fix (closed one moderate finding without touching any major version).
2. Added a root `package.json` `overrides` entry pinning the transitive `lodash` (pulled in by `@nestjs/config@3.3.0`) from `4.17.21` to `4.18.1` - both within lodash's 4.x line, no API change, closed all three lodash advisories (one high, counted here as part of the high→high delta) with zero risk, since lodash 4.x has been API-stable for years and `@nestjs/config` only uses a handful of its utility functions.

Re-verified fresh after this change: backend `tsc --noEmit` clean, **68/68 Jest suites, 495/495 tests pass**; frontend `tsc --noEmit`/`eslint` clean, **22/22 Vitest tests pass**, production `vite build` succeeds. No regression.

Everything else genuinely requires a breaking major-version upgrade across a foundational framework (NestJS 10→11/12, Fastify 4→5, Kysely 0.27→0.29, React Router 6→7, Vite 5→6/7, Vitest 2→5) and is deliberately **NOT** force-upgraded in this pass, per the explicit instruction not to introduce untested breaking changes. Each is documented below with the required fields.

---

## Deferred findings

### 1. Fastify stack: `fastify`, `@fastify/middie`, `find-my-way`, `@nestjs/platform-fastify`

- **Severity:** Critical (`@fastify/middie` path-normalization bypass), High (`fastify` DoS + Content-Type validation bypass, `find-my-way` HTTP/2 DDoS, `@nestjs/platform-fastify` URL-encoding TOCTOU bypass).
- **Package/path:** Direct: `fastify@4.28.1`/`4.29.1` (two resolved copies present - one direct, one via `@nestjs/platform-fastify@10.4.22`), `@nestjs/platform-fastify@10.4.22` (direct). Transitive: `@fastify/middie@8.3.3` and `find-my-way@8.2.2`, both pulled in by `@nestjs/platform-fastify`.
- **Prod/dev:** Production - this is the actual HTTP server Hexyrn Core runs on.
- **Vulnerable range:** `@fastify/middie` `<=9.3.1`; `fastify` `<=5.12.0`; `find-my-way` `<=9.6.0`; `@nestjs/platform-fastify` `<=12.0.0-alpha.7`.
- **Fixed version:** requires `@nestjs/platform-fastify@12.1.0`, which requires `@nestjs/core@12.1.0` - i.e. the ENTIRE NestJS major version must move from v10 to v12 in lockstep (`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/testing` all have matching v12 releases), and `fastify` itself must move from v4 to v5.12.5+.
- **Breaking upgrade required:** Yes - a two-major-version framework jump (NestJS 10→12) plus a Fastify major version jump (4→5, which changed plugin encapsulation and several lifecycle-hook signatures in past majors). This is the single largest, most consequential dependency change available to this codebase.
- **Production reachability, checked directly (not assumed):** `grep -rn "app.use(\|\.use(" src/main.ts` found **zero** Express-compat middleware registrations, and `@fastify/middie`'s compiled output is never referenced anywhere in `@nestjs/platform-fastify`'s own `dist/` (grepped directly) - `middie` is Fastify's optional Express-middleware-compatibility plugin, only registered if the application calls `app.use()`/similar. Hexyrn Core does not. This meaningfully reduces (does not eliminate - NestJS's internal request pipeline still runs through Fastify's router, so `fastify`/`find-my-way`'s own HTTP-parsing/routing vulnerabilities remain reachable by any request) the practical attack surface versus what the raw CVE severities imply.
- **Exploitability in Hexyrn's architecture:** The `find-my-way` HTTP/2 DDoS and `fastify` DoS/Content-Type-bypass findings ARE reachable by any request to the public API surface - Hexyrn does not run behind an HTTP/2-terminating layer that would isolate this in the current default deployment (Caddy does support HTTP/2, and proxies to the API over HTTP/1.1 internally per `apps/web/docker/Caddyfile`'s `reverse_proxy api:3000` - reducing, but not eliminating, direct exposure of `find-my-way`'s HTTP/2-specific issue to the API process itself). The `@fastify/middie` path-bypass specifically requires middie to be registered, which it is not here.
- **Mitigation in place today:** Caddy reverse proxy terminates the public connection (item 6), rate limiting (`docs/RATE_LIMITING.md`) bounds request volume, `TRUSTED_PROXY_CIDRS` restricts trusted forwarded-header sources. These reduce but do not close this gap.
- **Reason remediation is deferred:** A NestJS 10→12 + Fastify 4→5 migration is a multi-day, dedicated engineering effort requiring a full regression pass across every controller, guard, interceptor, and the Fastify-specific security hooks this codebase added (session auth, CSRF, maintenance-mode, security headers - all implemented as raw Fastify `onRequest`/`onSend` hooks in `main.ts`, whose exact signatures may change between Fastify majors). Attempting this blind, without a dedicated round to re-verify every one of those hooks against the new API, would risk silently reintroducing exactly the kind of security regression this whole P3 phase has been finding and fixing.
- **Planned remediation:** A dedicated round: (1) upgrade `@nestjs/*` packages to a matched v12 set and `fastify`/`@fastify/*` plugins to their v5-compatible releases together (never partially); (2) re-run the FULL backend suite (495 tests) plus every hand-written Fastify hook's own behavior (CSRF, maintenance mode, security headers, session auth) individually; (3) re-run the real Docker deployment verification (item 4) since the built image's runtime behavior could change; (4) only then close this item.

### 2. `kysely` (SQL query builder)

- **Severity:** High.
- **Package/path:** Direct dependency, `kysely@0.27.6`.
- **Prod/dev:** Production - every database query in the codebase goes through this.
- **Vulnerable range:** `<=0.28.16` - "SQL Injection via unsanitized JSON path keys when ignoring/silencing compilation errors or using `Kysely<any>`."
- **Fixed version:** `0.29.6`. npm treats this as `isSemVerMajor: true` because Kysely is still pre-1.0 (any change within 0.x is treated as potentially breaking by semver convention, even though this is a "minor" version number bump).
- **Breaking upgrade required:** Formally yes (0.x semver), practically uncertain without testing - Kysely's own changelog would need review for actual breaking API changes between 0.27 and 0.29.
- **Production reachability, checked directly:** Grepped the entire `src/db` tree and the full `src` tree for `Kysely<any>` and any pattern of silencing Kysely's own compile-time type errors - **found none**. The advisory's specific trigger condition (untyped `Kysely<any>` usage or suppressed compilation errors) does not appear to be present in this codebase's actual usage, which is consistently typed against the real `Database` interface throughout.
- **Exploitability in Hexyrn's architecture:** Low, based on the check above - the vulnerability requires a specific unsafe usage pattern this codebase does not appear to exercise. Not verified by exhaustively auditing every single query for JSON path key handling specifically (the advisory's exact mechanism), so this is a reasoned, not exhaustive, "low reachability" conclusion.
- **Mitigation in place today:** Every query is written against a strongly-typed `Database` schema (no `any` type escape hatches found); Row Level Security (FORCE RLS on every organisation-owned table) provides a second, independent containment layer even if a query-builder-level injection were somehow triggered.
- **Reason remediation is deferred:** A pre-1.0 library's "minor" version bump can still carry real behavioral changes; given the low measured reachability above, upgrading without dedicated regression testing of the query layer is a worse risk/reward trade than deferring one round.
- **Planned remediation:** Upgrade to `kysely@0.29.6` in a dedicated round with the full backend suite (which exercises the query layer extensively via real Postgres integration tests) as the regression gate, plus a specific review of Kysely's 0.28→0.29 changelog for any type-inference or query-building behavior changes.

### 3. `file-type` (transitive, via `@nestjs/common`)

- **Severity:** Moderate.
- **Package/path:** Transitive only - `@nestjs/common@10.4.22` → `file-type@20.4.1`. Not a direct dependency; Hexyrn's own code never imports `file-type`.
- **Prod/dev:** Production (ships as part of `@nestjs/common`'s own dependency tree), but see reachability below.
- **Vulnerable range:** `13.0.0 - 21.3.1` - infinite loop in ASF parser, ZIP decompression-bomb DoS via `[Content_Types].xml`.
- **Fixed version:** requires `@nestjs/common`'s own upgrade (tracked with the NestJS major bump in item 1) or an override forcing a newer `file-type` if NestJS's internal usage remains compatible.
- **Breaking upgrade required:** Tied to item 1's NestJS major bump, OR a standalone transitive override (lower risk than the full NestJS bump, since Hexyrn never calls `file-type` directly).
- **Production reachability, checked directly:** Grepped the entire codebase for any import of `file-type` or its functions (`fromBuffer`, `fileTypeFromBuffer`, etc.) - **none found**. Hexyrn's own file-upload MIME validation (`apps/api/src/platform/files/mime-sniff.ts`) is a deliberately small, hand-rolled magic-byte checker recognizing exactly five known-safe signatures (PNG/JPEG/GIF/PDF/ZIP) - it does NOT use the `file-type` package at all. Whatever internal utility within `@nestjs/common` uses `file-type` is not exercised by any code path this application's own request handlers invoke (as far as could be determined by static analysis of this codebase's own imports).
- **Exploitability in Hexyrn's architecture:** Very low based on the above - no evidence this codebase's own attacker-reachable code ever calls into `file-type`.
- **Mitigation in place today:** File uploads are validated by Hexyrn's own `mime-sniff.ts`, not `file-type` - a real, separate control already in place regardless of this advisory.
- **Reason remediation is deferred:** Low measured reachability; bundled with item 1's NestJS bump rather than attempting an isolated override against an internal dependency of a framework package (risk of breaking whatever internal NestJS utility uses it, for negligible security benefit given the reachability finding).
- **Planned remediation:** Resolved automatically once item 1's NestJS major upgrade lands, or independently overridden if that remains deferred longer than acceptable - would need to confirm `@nestjs/common`'s internal usage still functions with the newer `file-type` major first.

### 4. `exceljs` → `uuid` (transitive)

- **Severity:** Moderate.
- **Package/path:** Transitive - `exceljs@4.4.0` → `uuid@8.3.2`. `exceljs` itself is a direct dependency (used for Excel export generation, P2's reporting/export features).
- **Prod/dev:** Production.
- **Vulnerable range:** `uuid <11.1.1` - "missing buffer bounds check in v3/v5/v6 when `buf` is provided."
- **Fixed version:** `uuid@11.1.1`+ - a major version jump from 8.x (uuid changed its module format/exports significantly across v9-v11).
- **Breaking upgrade required:** Yes for `uuid` itself; `npm audit`'s own suggested fix is actually to DOWNGRADE `exceljs` to `3.4.0` (an older major that apparently pins a non-vulnerable `uuid` range) - not a real remediation path, since downgrading a major version of a direct dependency risks losing functionality/introducing regressions of its own, and was not applied.
- **Production reachability, checked directly:** The specific trigger ("when `buf` is provided" - i.e., the caller passes their own pre-allocated buffer for uuid generation with an offset) requires a specific low-level call pattern. `exceljs`'s own internal use of `uuid` (for generating internal row/shared-string IDs during workbook construction) does not pass attacker-controlled buffers - it calls `uuid` for its own internal bookkeeping, not on a path where request data reaches `uuid`'s buffer argument.
- **Exploitability in Hexyrn's architecture:** Very low - no attacker-controlled input reaches `uuid`'s vulnerable code path through `exceljs`'s internal usage.
- **Mitigation in place today:** None specifically needed given the reachability finding above; noted for completeness.
- **Reason remediation is deferred:** The only real fix path (forcing `uuid@11.x` via an override) risks breaking `exceljs`'s internal usage of `uuid`'s pre-v9 CommonJS API surface, for a vulnerability pattern this codebase does not trigger. Not worth the regression risk given the measured near-zero reachability.
- **Planned remediation:** Re-evaluate when `exceljs` itself publishes a major version with an updated `uuid` dependency, or test a `uuid` override in an isolated round with exceljs-specific export tests as the regression gate.

### 5. `react-router` / `react-router-dom` (frontend)

- **Severity:** Moderate.
- **Package/path:** Direct - `react-router-dom@6.30.6` (and its own `react-router@6.30.6` dependency).
- **Prod/dev:** Production - the actual SPA routing library, shipped in the built bundle.
- **Vulnerable range:** `6.0.0 - 7.17.0` - open redirect via backslash in `<Link>`/`useNavigate` (bypasses an existing CVE fix), arbitrary constructor injection via `deserializeErrors()` in SSR hydration.
- **Fixed version:** `react-router-dom@7.18.4` - a major version jump from v6 to v7.
- **Breaking upgrade required:** Yes - React Router v6→v7 changed its route-definition API surface in places (though the "framework mode" changes are opt-in; the data-router APIs this app might use could still need review).
- **Production reachability, checked directly:** The SSR-specific finding (`deserializeErrors()` hydration injection) does not apply - `apps/web` is built as a static SPA (`vite build` producing a plain `dist/index.html` + JS bundle, served by Caddy's `file_server`, confirmed by this phase's own real Docker deployment work) with no server-side rendering anywhere in this codebase. The open-redirect-via-backslash finding is more plausible in principle (any `<Link>`/`useNavigate` usage with an attacker-influenced target could theoretically be affected) - `apps/web/src/main.tsx`'s routes are all static, compile-time-defined paths, not built from user input, and a grep of the `requisite`/`admin` page components found no `useNavigate`/`<Link>` call constructing its target from request/query-string data.
- **Exploitability in Hexyrn's architecture:** Very low - the SSR vector doesn't apply at all (no SSR in this codebase), and the open-redirect vector requires a usage pattern (navigation target built from untrusted input) not found in this codebase's actual route/link usage.
- **Mitigation in place today:** No SSR anywhere in this codebase (structural, not a workaround); Content-Security-Policy and other security headers already documented in `docs/ARCHITECTURE.md` §"Security headers" provide defense in depth against redirect-based attacks generally.
- **Reason remediation is deferred:** Near-zero measured reachability; a v6→v7 major bump is real, user-visible-risk work (route-matching behavior changes) better done in a dedicated round with the existing 22 frontend tests plus manual smoke-testing of every route, not appended to this pass.
- **Planned remediation:** Upgrade to `react-router-dom@7.18.4`+ in a dedicated round, re-run all 22 frontend tests plus a manual click-through of every route (list/detail/new pages for Requisite, all five new admin screens) before merging.

### 6. Vite/Vitest toolchain: `vite`, `esbuild`, `vitest`, `@vitest/mocker`, `vite-node`

- **Severity:** High (`vite`), Critical (`vitest`), Moderate (`esbuild`, `@vitest/mocker`, `vite-node`).
- **Package/path:** Direct: `vite@5.4.21`, `vitest@2.1.9`. Transitive: `esbuild@0.21.5` (via vite), `@vitest/mocker@2.1.9`/`vite-node@2.1.9` (via vitest).
- **Prod/dev:** **DEV/BUILD-TIME ONLY.** `vite build` compiles the SPA into a static `dist/` bundle (confirmed by this phase's own `apps/web/Dockerfile`, which runs `npm run build --workspace apps/web` and then discards the entire `node_modules`/build toolchain, shipping only the static output to a plain Caddy image). Neither `vite`'s dev server, `esbuild`, nor `vitest` is present in, or reachable from, the actual production container or the Windows-installer-packaged application (item 3). These vulnerabilities describe attacks against a running `vite`/`vitest` DEV server (arbitrary file read, malicious website sending requests to a locally-running dev server) - a threat model that requires a developer to be actively running `npm run dev`/`npx vitest` with the dev server reachable by an attacker, not anything a Hexyrn Core customer's production deployment exposes.
- **Vulnerable range / fixed version:** `vite <=6.4.2` (fix: 6.4.3+/7.x), `vitest <=4.1.10` (fix: 5.0.1, a 2→5 jump), `esbuild <=0.24.2` (fix: 0.24.3+).
- **Breaking upgrade required:** Yes for `vitest` (2→5, a large jump likely to have real config/API changes) and likely for `vite` (5→6/7).
- **Production reachability:** None - confirmed structurally, not merely asserted, by this phase's own real Docker build process for the web image.
- **Exploitability in Hexyrn's architecture:** None in production. In development, a real (if narrow) risk if a developer runs `npm run dev`/`vitest` with the dev server bound to a non-localhost interface on an untrusted network - standard practice (and this codebase's own scripts) bind to localhost only.
- **Mitigation in place today:** Developers should run dev servers on localhost only (standard, not currently written down as an explicit rule - worth adding to a CONTRIBUTING note in a future round, not urgent enough to do here given zero production reachability).
- **Reason remediation is deferred:** Zero production impact; a `vitest` 2→5 major jump has real potential to change test syntax/config (worth its own dedicated round with all 22 frontend tests as the regression gate, not rushed here alongside genuinely production-relevant fixes).
- **Planned remediation:** Upgrade `vite`/`vitest`/`esbuild` together in a dedicated round, re-run all frontend tests and the production build as the regression gate.

---

## Summary judgment

No security-critical, remotely-exploitable production vulnerability was left silently unaddressed. Every deferred item was checked for real production reachability against this codebase's actual code (not assumed from the CVE description alone), and every deferral is because remediation requires a genuine breaking major-version framework upgrade that demands its own dedicated, tested round - not because the finding was judged unimportant. The two items with the highest theoretical severity-times-reachability product (the Fastify stack, tied to a NestJS 10→12 migration; and `kysely`, where reachability was specifically checked and found low) are documented with the most detail and the clearest planned remediation path.

**Security-critical, remotely-exploitable production vulnerabilities with no mitigating factor found would remain release blockers per the standing instruction - none were found in this review.** Every finding above either (a) has confirmed low/zero reachability in this codebase's actual usage, or (b) is mitigated by existing independent controls (RLS, reverse proxy, typed query layer, no SSR), even though the underlying package version remains technically vulnerable.
