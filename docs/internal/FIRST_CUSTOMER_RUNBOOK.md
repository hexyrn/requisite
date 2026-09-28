# First-customer deployment runbook (P3 item 21)

> **Internal / developer document. Not for customers.** Requisite is delivered to customers only as the Windows installer
> (`Requisite-Setup.exe`, see [`../INSTALL_WINDOWS.md`](../INSTALL_WINDOWS.md)). Docker is used by Hexyrn for development, CI
> and integration/PostgreSQL testing; it is **not** a supported customer deployment method.

Operational checklist for deploying Hexyrn Core + Requisite to an actual
paying customer, distinct from the general `docs/internal/OPERATOR_GUIDE.md`
reference documentation - this is the sequence to follow, in order, once.

## Pre-deployment requirements

- [ ] Customer's server/environment meets `docs/internal/OPERATOR_GUIDE.md` §1
      (Node 20, PostgreSQL 17 - Hexyrn's officially supported version for
      Core/Requisite 1.0 - sufficient disk for database + uploads +
      backups).
- [ ] Customer has a domain name and can point DNS at the deployment.
- [ ] Customer has decided their SMTP provider (or explicitly opted to
      skip SMTP and share invite/reset links manually).
- [ ] Customer's signed Requisite licence file is in hand.
- [ ] A reverse proxy (nginx/Caddy/Traefik) with TLS is planned or
      already provisioned.

## Release verification

- [ ] Download the release artifact from the verified source.
- [ ] Verify the release manifest's signature against the trusted public
      key set (`docs/RELEASE_SIGNING.md`) before installing anything.

## Installation

- [ ] Follow `docs/internal/OPERATOR_GUIDE.md` §2 (Docker or manual, per what the
      customer's environment supports - Windows installer not yet
      available, see `P3-ENVIRONMENT-VERIFICATION.md`).
- [ ] Confirm `NODE_ENV=production` and every required secret is set
      (the app refuses to start otherwise - `production-config-check.ts`).

## TLS

- [ ] Reverse proxy terminates TLS; `COOKIE_SECURE=true`.
- [ ] `TRUSTED_PROXY_CIDRS` set to the proxy's actual address/CIDR.
- [ ] `ALLOWED_ORIGINS` set to the customer's real public HTTPS URL.

## Bootstrap

- [ ] Complete first-run bootstrap (`docs/BOOTSTRAP.md`) - organisation
      name, owner account, using a genuinely strong owner password.
- [ ] Confirm bootstrap is now permanently disabled (attempting it again
      is refused).

## SMTP

- [ ] Configure via `POST /api/v1/smtp`, then `POST /api/v1/smtp/test` to
      a real mailbox the customer can check - confirm actual delivery,
      not just a 200 response.

## Licence

- [ ] Import the Requisite licence: `POST /api/v1/apps/com.hexyrn.requisite/licence`.
- [ ] Confirm via `GET /api/v1/apps/com.hexyrn.requisite/licence` -
      `licenceValid: true`, correct `licensedMajorVersion`.

## Users

- [ ] Create/invite the customer's initial user set with appropriate
      roles (see `docs/REQUISITE_ADMIN_GUIDE.md`'s permission table).
- [ ] Confirm at least one genuinely distinct approver exists (not the
      same account as any requester who will submit requisitions - the
      server blocks self-approval, so this matters operationally).
- [ ] Enrol MFA for every administrator account before handover.

## Requisite configuration

- [ ] Enable Requisite for the organisation.
- [ ] Configure numbering, categories/custom fields, and approval
      routing per the customer's actual process
      (`docs/REQUISITE_ADMIN_GUIDE.md`).
- [ ] Import or manually create initial suppliers.

## Backup

- [ ] Set `HEXYRN_BACKUP_DIR` to a location OFF the primary application
      disk (a genuinely separate volume/mount, not just a different
      folder on the same disk - see Architecture's off-site backup
      warning intent).
- [ ] Run a real `POST /api/v1/backup` and confirm it succeeds
      (`GET /api/v1/backup` shows it, `valid: true`).
- [ ] **Restore test**: on a SEPARATE, non-production instance/database,
      restore this backup and confirm the customer's actual seeded data
      comes back correctly. Do not skip this step - an untested backup is
      not a verified backup (`docs/DISASTER_RECOVERY.md`).

## Security verification

- [ ] Run through `docs/internal/FIRST_CUSTOMER_SECURITY_CHECKLIST.md` in full.

## Customer handover

- [ ] Provide the customer: their owner login, `docs/internal/OPERATOR_GUIDE.md`,
      `docs/REQUISITE_ADMIN_GUIDE.md`, `docs/REQUISITE_USER_GUIDE.md`,
      and this runbook's completed checklist as a record of what was
      verified.
- [ ] Confirm the customer knows how to reach support and generate a
      support bundle (`docs/internal/OPERATOR_GUIDE.md` §13) if they need to.
