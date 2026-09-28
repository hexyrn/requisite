# Hexyrn Core

The free, self-hostable, shared foundation for the Hexyrn family of business
applications. Core provides mechanisms - authentication, organisation
structure, permissions, audit, reporting extension points - never business
domain logic. See `docs/ARCHITECTURE.md` for the full, frozen architecture.

This repository implements Core through **P3** (release engineering) plus the
**Requisite** purchasing application. Current status, known gaps and the next
recommended task are in **`docs/DEVELOPMENT_STATUS.md`** - start there. Per-phase
deviations from the architecture are in `docs/decisions/`.

## Repository layout

```
apps/
  api/                 NestJS (Fastify) backend
  web/                 React (Vite) frontend
packages/
  shared-types/        Types shared between api and web
  app-sdk/              Manifest/capability contract types (no loader in P0)
  design-system/        Minimal React UI primitives
docs/
  ARCHITECTURE.md       Frozen architecture spec
  decisions/             ADRs and the P0 deviations log
  internal/SETUP.md      Developer environment detail
  BOOTSTRAP.md            First-run setup flow
```

## Installing (customers)

Requisite is a **Windows product**. Customers receive one file, `Requisite-Setup.exe`, and follow
**[`docs/INSTALL_WINDOWS.md`](docs/INSTALL_WINDOWS.md)**. Nothing else has to be installed or configured.

## Developing (Hexyrn engineers)

Everything below is for working on the code, not for customer deployment. Docker is used here only for a local
PostgreSQL and for CI/integration testing; it is not a supported way for customers to run Requisite.

Prerequisites: Node.js 20+, and a PostgreSQL 17 (Docker is the easiest way to get one locally).

```bash
git clone <this repo>
cd hexyrn-core
cp .env.example .env          # edit SESSION_SECRET / TOTP_MASTER_KEY for real use
npm install
docker compose up -d postgres
npm run migrate
npm run dev:api                # http://localhost:3000
# in a second terminal
npm run dev:web                # http://localhost:5173
```

On first API boot a one-time setup token is printed to the console and written to `bootstrap-token.txt`. Visit
`http://localhost:5173/setup#token=<token>` to create the organisation. See `docs/BOOTSTRAP.md`.

Windows installer work: build with `scripts/windows/build-release.ps1` (see `docs/WINDOWS_SIGNING.md`), and test with
the layers described in **[`docs/WINDOWS_TESTING.md`](docs/WINDOWS_TESTING.md)** — including the clean-VM acceptance
script, which must pass on a real Windows VM before a release. Other internal docs live in `docs/internal/`.

## Tests

```bash
docker compose up -d postgres_test
npm test --workspace apps/api
```

Tests that need a real Postgres are gated behind `TEST_DATABASE_URL` (see
`.env.example`) and are skipped (not silently passed) if it isn't set.

## Database / migrations

See `docs/decisions/0001-database-layer.md` for why this project uses raw
`pg` + Kysely + hand-written SQL migrations instead of an ORM's own
migration tool. Migrations live in `apps/api/src/db/migrations/*.sql` and
are applied explicitly:

```bash
npm run migrate --workspace apps/api
```

Never applied automatically on boot.
