# Running Hexyrn

> **Internal / developer document. Not for customers.** Requisite is delivered to customers only as the Windows installer
> (`Requisite-Setup.exe`, see [`../INSTALL_WINDOWS.md`](../INSTALL_WINDOWS.md)). Docker is used by Hexyrn for development, CI
> and integration/PostgreSQL testing; it is **not** a supported customer deployment method.


Three ways to run it. **Docker (A) is the supported deployment path** and the only one verified end to end.

|                                    | For                                                 | Status                                        |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| **A. Docker Compose**              | a real installation (HTTPS, PostgreSQL 17, backups) | verified end to end (see "What was verified") |
| **B. Local development**           | changing the code                                   | verified                                      |
| **C. Windows installer (MSI/EXE)** | non-technical Windows customers                     | compiled but never installed; do not use yet  |

---

## A. Docker Compose (production)

### You need

- Docker Desktop (Windows/Mac) or Docker Engine + Compose v2 (Linux)
- Node.js 20+ (only to run two small helper scripts; the app itself runs in containers)
- Ports 80 and 443 free

### 1. Get the code and create your secrets

```powershell
git clone https://github.com/hexyrn/requisite.git
cd requisite
git checkout claude/clever-faraday-5k3i06     # until it is merged
```

Generate a production `.env` with fresh random secrets **and** your licence signing keys (you are both the vendor
and the operator):

```powershell
node scripts/generate-prod-env.js --host localhost --generate-licence-keys ./licence-keys
```

- `--host` is the name people will type. Use `localhost` for a trial on one machine, or a real DNS name
  (e.g. `hexyrn.yourcompany.com`) for a server; Caddy then gets a Let's Encrypt certificate automatically (ports 80 and
  443 must be reachable from the internet).
- Already have a licence public key from an earlier `keygen`? Use `--licence-public-key <value>` instead of
  `--generate-licence-keys`.
- The script refuses to overwrite an existing `.env` or signing key.

**Back up `.env` and `licence-keys/licence-private.pem` somewhere safe and offline.** Losing
`TOTP_MASTER_KEY_CURRENT` / `SECRET_ENCRYPTION_MASTER_KEY` makes stored MFA and SMTP secrets unrecoverable; the
private licence key is what lets you issue licences. Neither file is ever committed (both are git-ignored) or baked into
an image (`.dockerignore`).

### 2. Start it

```powershell
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes a few minutes. It starts PostgreSQL 17, applies the database migrations, starts the API, and
starts Caddy (HTTPS). Check it:

```powershell
docker compose -f docker-compose.prod.yml ps
```

`postgres` and `api` should say healthy; `migrate` should say exited (0).

### 3. First-run setup

1. Get the one-time setup token:

   ```powershell
   docker compose -f docker-compose.prod.yml logs api | Select-String -Context 0,1 "SETUP TOKEN"
   ```

   (Linux/Mac: `docker compose -f docker-compose.prod.yml logs api | grep -A1 "SETUP TOKEN"`.)
   The token is re-issued on every restart until setup is complete, so if you lose it, just
   `docker compose -f docker-compose.prod.yml restart api` and read the new one.

2. Open **https://localhost/setup** (or your hostname). With `localhost` your browser will warn about the certificate
   (Caddy's own local CA); that is expected. To remove the warning, trust Caddy's root certificate:
   `docker compose -f docker-compose.prod.yml cp web:/data/caddy/pki/authorities/local/root.crt .` and install it.

3. Enter the token, your organisation details, and the owner email and password (12+ characters). You are sent to the
   sign-in page.

### 4. Activate Requisite (licence)

Requisite runs only with a licence issued for **your organisation**.

1. Sign in, open **Administration → Licence** and copy the **Organisation ID**.
2. Issue a licence with your private key (from the repo root; paths are relative to `apps/api`):

   ```powershell
   npm install
   npm run licence --workspace apps/api -- issue --key ../../licence-keys/licence-private.pem --org <ORGANISATION-ID> --out ../../my.licence
   ```

   Optional: `--support-expires 2027-09-28` (informational only; it never switches the app off) and `--major 1`.

3. Paste the contents of `my.licence` into **Administration → Licence → Import licence file** and click Import. The
   first import activates Requisite and gives the Owner role its permissions. Go to **Home → Requisite**.

Licences are checked offline against `HEXYRN_LICENSE_PUBLIC_KEY`; there is no activation server.

### 5. Everyday operations

| Task                     | Command / place                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Stop (keeps all data)    | `docker compose -f docker-compose.prod.yml down`                                                                               |
| Start again              | `docker compose -f docker-compose.prod.yml up -d`                                                                              |
| Logs                     | `docker compose -f docker-compose.prod.yml logs -f api`                                                                        |
| Backup / restore         | **Administration → Backup & Restore** (stored in the `hexyrn_backups` volume)                                                  |
| Email (SMTP)             | **Administration → SMTP**                                                                                                      |
| Health                   | **Administration → Health**                                                                                                    |
| Upgrade to a new version | `git pull`, then `docker compose -f docker-compose.prod.yml up -d --build` (migrations run automatically; take a backup first) |
| **Delete everything**    | `docker compose -f docker-compose.prod.yml down -v` (destroys the database and files)                                          |

Take backups regularly and copy them off the machine: the volume lives on the same disk as the database.

### Troubleshooting

- **`docker compose` says a variable must be set:** `.env` is missing or incomplete; rerun step 1.
- **API keeps restarting:** `docker compose -f docker-compose.prod.yml logs api`. In production the server refuses to
  start, and lists every missing setting, if a required secret is absent or the wrong length.
- **Login fails with "Origin not allowed":** you are using a different address than `HEXYRN_PUBLIC_HOSTNAME`. Add it to
  `ALLOWED_ORIGINS` in `.env` (comma-separated, with `https://`).
- **Requisite tile says "Disabled"/"Not licensed":** import the licence (step 4).
- **`npm run licence` says "organisation id ... is not a UUID":** copy the ID from Administration → Licence.
- **Build fails with "npm ci did not install dependencies":** a flaky network during `npm ci`; just rerun the build.

---

## B. Local development

Needs Node.js 20+ and Docker (for PostgreSQL) or a local PostgreSQL.

```bash
npm install
cp .env.example .env            # Windows: copy .env.example .env
# put real random values for TOTP_MASTER_KEY_CURRENT and SECRET_ENCRYPTION_MASTER_KEY: openssl rand -base64 32
docker compose up -d postgres postgres_test
npm run build:packages
npm run migrate
npm run dev:api                 # http://localhost:3000   (prints the setup token on first start)
npm run dev:web                 # http://localhost:5173   (second terminal)
```

Browse **http://localhost:5173** (not `127.0.0.1`: the API only accepts the configured origin). Then follow the setup
and licence steps from section A; with no `HEXYRN_LICENSE_PUBLIC_KEY` set, development falls back to the publicly
committed **test** licence key, so `npm run licence` with your own key is not needed: use the seeded demo instead:

```bash
DATABASE_URL=<owner connection string> npx ts-node apps/api/scripts/e2e-seed.ts   # WIPES the database, seeds a licensed demo org
# owner login is written to e2e/fixtures/seed-output.json
```

### Tests

```bash
export TEST_DATABASE_URL=postgres://hexyrn:hexyrn_test_password@localhost:5433/hexyrn_core_test
npm test                                 # backend: 71 suites, DB suites are skipped (loudly) without TEST_DATABASE_URL
npm run test --workspace apps/web        # frontend
npm run typecheck && npm run lint && npx prettier --check "apps/**/src/**/*.{ts,tsx}" "e2e/**/*.ts" "*.md" "docs/**/*.md"
# browser tests: API on :3000, web on :5173, reseed first (the lifecycle test needs a fresh database)
npm run test --workspace e2e             # E2E_CHROMIUM_PATH=<chrome> to use an installed browser
```

---

## C. Windows installer

`installer/windows` builds an MSI and an EXE bundle that include Node and PostgreSQL. They compile, but have **never
been installed on a clean machine**, are unsigned, and the service configuration is not fully wired (see
`docs/internal/WINDOWS_ACCEPTANCE_PREP.md`). Use Docker Desktop on Windows instead until that acceptance test is done.

---

## What was verified (and what was not)

Verified on the real production stack (Docker Compose, PostgreSQL 17, Caddy HTTPS), driven through a real browser:
first-run setup, sign-in, launcher, wrong-organisation licence rejected, licence import activating Requisite, opening
Requisite, saving SMTP settings (encrypted), **Backup Now and a real restore** (cleared data returned), a full
`down`/`up` cycle keeping data, setup-token re-issue before setup, HTTPS + HSTS + HTTP→HTTPS redirect, foreign origin
rejected, API running as a non-root user.

Not verified in the environment used to prepare this: Let's Encrypt certificates for a public hostname; the
`apk add postgresql17-client` line in `apps/api/Dockerfile` (that build environment blocked Alpine's package servers,
so the real client tools were mounted into the container for the backup test instead; the build now fails loudly if
`pg_dump` is missing, so a wrong package cannot ship silently: watch the first `--build` for that line); the Windows
installer; Docker Desktop on Windows itself.
