# Logging & error handling (P3 item 13/22/23)

## Model: structured JSON to stdout, rotation delegated to the deployment environment

`apps/api/src/logging/logger.ts`'s `logStructured()` writes one JSON line
per event to stdout (`console.log`). This is a deliberate choice, not an
oversight: Hexyrn Core does not manage its own log files, rotation, or
retention in-process. Instead:

- **Docker deployments**: the container's stdout is captured by Docker's
  own logging driver (`json-file` by default, with `max-size`/`max-file`
  options for rotation - see [Docker's logging driver docs]; `local`,
  `journald`, or a remote driver are equally valid operator choices).
  `docker-compose.yml` does not currently set explicit rotation options -
  operators running this in production should add
  `logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }`
  (or their preferred driver) to the app service once it exists (P3 item 4
  - production compose is not yet written, tracked separately).
- **Windows service deployments** (once the installer exists - P3 item 3):
  a Windows Service typically redirects stdout to a file the service
  manager rotates, or the process is run under a supervisor (NSSM, etc.)
  with its own log-rotation configuration.
- **Bare-metal/systemd deployments**: `journald` captures stdout
  automatically with its own retention policy (`journalctl --vacuum-*`),
  or a supervisor redirects to a file for `logrotate` to manage.

This is the same reasoning that led backup.service.ts to shell out to
`pg_dump`/`pg_restore` rather than reimplement a Postgres dump format:
log rotation is a well-solved, standard operational concern the
deployment platform already does correctly - reimplementing it in-process
(size-based file rotation, compression, retention sweeps) would be a
redundant, worse version of infrastructure that already exists at every
deployment layer this product targets.

**What this means concretely for an operator:** "where are the logs" is
"wherever your container/service/init system sends stdout" - there is no
`hexyrn.log` file this application writes itself. This is why
`support-bundle.service.ts`'s `logsNote` field states plainly that the
generated bundle cannot include log excerpts - it has no file to read from

- and recommends attaching relevant stdout capture manually.

## Correlation IDs / reference IDs

Every HTTP request gets a Fastify-generated request id (`request.id`,
enabled by default). `apps/api/src/http/global-exception.filter.ts` (P3
item 13/23) surfaces this same id to the client as `referenceId` on every
error response and logs it as `correlationId` on the corresponding
server-side log line - an admin can grep stdout for a `referenceId` a user
reports and find the exact request, without needing a separate
correlation-id-generation scheme layered on top of what Fastify already
provides.

## Redaction

Two independent layers exist, deliberately overlapping rather than relying
on just one:

1. `logging/logger.ts`'s `redact()` - every `logStructured()` call's
   `context` object is scanned recursively; any KEY matching
   `SENSITIVE_KEY_PATTERN` (password/secret/token/totp/authorization/
   cookie/hash/credential) is replaced with `[REDACTED]` before the line
   is ever written.
2. `platform/support-bundle/support-bundle.service.ts`'s `scrubFreeText()`
   - a VALUE-based pass (contextual credential patterns plus a generic
     token-shape fallback) for free-text fields a key-based redactor cannot
     protect, such as an error message that happens to echo a credential.
     `global-exception.filter.ts` reuses this exact function when logging an
     unhandled error's message, for the same reason the support bundle
     needed it: a canary test proved a credential CAN appear inside
     ordinary free text, not just under a suspiciously-named key.

## Error handling for ordinary users vs admins

`global-exception.filter.ts` (P3 item 13/23) draws the line explicitly:

- **HttpException** (every controller's own deliberately-thrown
  `BadRequestException`/`ForbiddenException`/etc.) - these already carry a
  safe, human-written message; passed through unchanged, plus a
  `referenceId`.
- **Anything else** (a raw driver error, an unexpected bug) - NEVER
  exposes `.message`/stack/SQL to the caller. The response is a generic
  "contact support with reference ID `<id>`" message; the full detail is
  logged server-side only, through the redaction layers above.

There is currently no separate "admin sees more diagnostic context than
an ordinary user" tier in the HTTP error response itself (item 23's
"Admins may see more diagnostic context" is not yet built as a
differentiated response shape) - an admin investigating an error today
uses the `referenceId` to find the corresponding server-side log line
(via whatever stdout capture their deployment uses) or the System
Health/Diagnostics endpoints (P3 item 19/20,
`platform/health/health-diagnostics.service.ts`) rather than a richer
error payload. Tracked as narrower follow-up, not silently assumed done.

## Levels

`LogEntry.level` (`'debug' | 'info' | 'warn' | 'error'`, defaulting to
`'info'` when omitted) - every pre-existing `logStructured()` call site
keeps working unchanged (the field is optional), and `global-exception.filter.ts`
sets it explicitly: `'error'` for an unhandled (non-HttpException) error
or any 5xx HttpException, `'warn'` for a 4xx HttpException. A log
aggregator or `jq` filter can select on `.level` directly without a
lookup table. Not every call site across the codebase has been reviewed
to set a non-default level yet (most remain implicitly `'info'`) - the
mechanism exists and is used on the error path, which is the one that
matters most for item 22's "useful levels" requirement; broadening
explicit level-setting to every log call site is narrower follow-up, not
required for this to be a real, working mechanism today.

[Docker's logging driver docs]: https://docs.docker.com/config/containers/logging/configure/
