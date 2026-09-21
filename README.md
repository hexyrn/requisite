# Hexyrn Core

The free, self-hostable, shared foundation for the Hexyrn family of business
applications. Core provides mechanisms - authentication, organisation
structure, permissions, audit, reporting extension points - never business
domain logic. See `docs/ARCHITECTURE.md` for the full, frozen architecture.

This repository currently implements **P0** only (see
`docs/decisions/P0-DEVIATIONS.md` for anything that deviated from the
architecture, and the implementation report delivered alongside this build
for exactly what P0 covers).

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
  SETUP.md               This document's detail, dev environment
  BOOTSTRAP.md            First-run setup flow
```

## Quick start

Prerequisites: Node.js 20+, Docker (for local Postgres).

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

On first API boot, a one-time setup token is printed to the console and
written to `bootstrap-token.txt` in the API's working directory. Visit
`http://localhost:5173/setup`, enter the token, and complete the setup
wizard to create your organisation and owner account. See
`docs/BOOTSTRAP.md` for details.

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
