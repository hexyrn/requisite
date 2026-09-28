# Development Environment Setup

> **Internal / developer document. Not for customers.** Requisite is delivered to customers only as the Windows installer
> (`Requisite-Setup.exe`, see [`../INSTALL_WINDOWS.md`](../INSTALL_WINDOWS.md)). Docker is used by Hexyrn for development, CI
> and integration/PostgreSQL testing; it is **not** a supported customer deployment method.


## Prerequisites

- Node.js 20 or later
- npm 10 or later (ships with Node 20)
- Docker + Docker Compose (for local Postgres)

## 1. Clone and install

```bash
git clone <this repo>
cd hexyrn-core
npm install
```

This is an npm workspaces monorepo (`apps/*`, `packages/*`) - a single
`npm install` at the root installs everything.

## 2. Environment variables

```bash
cp .env.example .env
```

Edit `.env` and set real values for:

- `SESSION_SECRET` - `openssl rand -base64 48`
- `TOTP_MASTER_KEY` - `openssl rand -base64 32` (must decode to exactly 32 bytes)

Leave `DATABASE_URL` / `TEST_DATABASE_URL` pointing at the docker-compose
services unless you're running Postgres elsewhere.

## 3. Start Postgres

```bash
docker compose up -d postgres postgres_test
```

`postgres` (port 5432) is the development database. `postgres_test` (port 5433) is a separate instance used only by the automated test suite, so
running tests never touches your dev data.

## 4. Run migrations

```bash
npm run migrate
```

Applies every `.sql` file in `apps/api/src/db/migrations/` in order, once,
tracked in a `schema_migrations` table. Never run automatically on boot -
always an explicit step, including in production deployments.

## 5. Run the API and web app

```bash
npm run dev:api     # NestJS/Fastify on http://localhost:3000
npm run dev:web      # Vite dev server on http://localhost:5173, proxies /api to the API
```

On first boot, the API generates a one-time bootstrap/setup token (see
`docs/BOOTSTRAP.md`). Complete setup at `http://localhost:5173/setup`.

## 6. Tests

```bash
npm test --workspace apps/api
```

Pure-logic tests (PermissionEvaluator, structured logging redaction, Argon2id,
TOTP, secure tokens) run without any external dependency. Integration tests
(the RLS/organisation-context security matrix, bootstrap-token-reuse,
session/account-deactivation, password-reset/invitation single-use, and the
Nest app boot test) require `postgres_test` to be running and
`TEST_DATABASE_URL` to be set - they are skipped (and say so) if it isn't.

## 7. Lint / typecheck

```bash
npm run lint
npm run typecheck
```

## Common issues

- **"DATABASE_URL is not set"**: copy `.env.example` to `.env` first.
- **Migrations fail with a permission/connection error**: confirm
  `docker compose ps` shows `postgres` as healthy before running `npm run migrate`.
- **argon2 native build fails on install**: this package compiles a native
  addon; if you're on an unsupported platform/architecture, see the
  `argon2` npm package's own installation notes.
