# Hexyrn App SDK (P1)

This document is the reference for `@hexyrn/app-sdk` and how an application
built on Hexyrn Core is expected to integrate with it. Every claim here is
backed by real, passing tests in `apps/api/src/platform/**/__tests__` and
`apps/api/src/apps/reference/__tests__` - where a mechanism is described as
working a certain way, it is because a test proves it, not because this
document says so.

## The two halves of the SDK

`packages/app-sdk/src/manifest.ts` - **`HexyrnAppManifest`**, the
declarative contract an app's entry module exports so Core's App Registry
can discover it. This is data, read once at boot (`registerApp`).

`packages/app-sdk/src/context.ts` - **`HexyrnAppContext<Db>`**, the runtime
object Core hands to an app's own service/handler code for every request.
This is the _only_ way application code touches Core - an app never
imports `apps/api/src/platform/**` directly, and never queries another
app's (or Core's own) database tables. The concrete implementation
(`AppContextFactory`, `apps/api/src/platform/app-context.factory.ts`) is
built once per request, inside `withOrgContext`, and is backed by the real
platform services - the SDK type is a contract, not a mock; the reference
app's controller and service (`apps/api/src/apps/reference/`) never import
a platform service directly, only `AppContextFactory` and the `ctx` object
it returns.

## Application lifecycle

Every app has four independent, non-conflated states (Architecture §3):

| State          | Meaning                                                                                                         | Set by                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **installed**  | The app's manifest is registered (`installed_applications`, no RLS - installation-level, not organisation data) | `ApplicationRegistryService.registerApp()` at boot, for every compiled-in app                                                               |
| **enabled**    | An admin turned it on for _this_ organisation (`app_enablements`, RLS-protected)                                | `ApplicationRegistryService.enableApp(db, orgId, appId)`                                                                                    |
| **licensed**   | A valid license record exists for this org+app+major version (`application_licenses`)                           | `ApplicationRegistryService.grantLicense(...)`. P1 uses simplified verification - see `docs/decisions/0004-app-licensing-simplification.md` |
| **compatible** | The app's `requiresCoreVersion` is satisfied by the running Core version                                        | Computed at read time, `isCoreVersionCompatible()` (`apps/api/src/platform/core-version.ts`)                                                |

**Active** = `installed ∧ enabled ∧ licensed ∧ compatible` - the one gate
that determines whether an app's code is allowed to run at all.
`ApplicationRegistryService.getApplicationState(db, orgId, appId)` is the
single source of truth every other mechanism (routes, capability
resolution, event delivery, job execution) consults.

Route-level enforcement: `@BelongsToApp(appId)` + `ApplicationActiveGuard`
(`apps/api/src/platform/app-registry/application-active.guard.ts`) on a
controller returns **404, not 403**, for any request against an inactive
app - it never confirms the route exists to an unentitled caller. Verified
end-to-end in `reference-app.e2e.integration.spec.ts` ("APP INACTIVITY").

## Appearing in the suite (launcher, colour, icon)

Core hosts the suite: its home page and the app switcher list every app the signed-in user can open. An app gets a
tile automatically once it is registered, enabled, licensed and compatible, and the user holds the permission of at
least one `navigation` entry; the tile opens the lowest-`order` entry the user may see. Users who may not use an app
never learn it exists.

Two optional manifest fields control presentation (see `docs/DESIGN_SYSTEM.md`):

```ts
brand: { color: '#0f766e', icon: 'cart' },   // accent colour (#rrggbb) + built-in icon key
internal: true,                               // test/reference apps: never listed
```

`color` is the only per-app styling knob; the whole app UI derives from it. Endpoint: `GET /api/v1/apps/launcher`.

## Capability registry

Apps ask for a _capability_ (`purchasing.cost-source.v1`), never for a
specific app ("is Requisite installed?"). `CapabilityResolverService.resolve(db,
orgId, capability)` returns every provider that is currently **active**
for that organisation - an installed-but-disabled or unlicensed provider
is silently excluded, and an absent capability returns an empty list, not
an error (`capability-resolver.integration.spec.ts`). Capability version,
application version, and Core version are three independent axes - a
manifest declares `{ capability: 'x.y.v1', provides: { serviceRef } }`
under `capabilities`, unrelated to its own `version`/`majorVersion`.

## Events (transactional outbox)

`ctx.events.publish(db, eventType, payload, version?)` writes an
`event_outbox` row in the SAME transaction as whatever business change
caused it - if the transaction rolls back, the event was never published.
A consumer registers `eventsConsumed: [{ eventType, handlerRef }]` in its
manifest and an actual handler function via
`EventHandlerRegistryService.register(handlerRef, fn)` at boot.
`EventDispatcherService.dispatchPending()` delivers pending events:

- **Absence tolerance**: an event with no registered consumers dispatches
  trivially; a publisher never needs to know or care who's listening.
- **Inactive consumer**: skipped (recorded `status: 'skipped'`), not
  errored, not silently dropped.
- **Idempotency + retry**: one `event_deliveries` row per (event,
  consumer); a `'delivered'` row is never re-invoked; a failure retries up
  to 5 attempts with the outbox row left un-dispatched until every
  consumer reaches a terminal state.
- **Organisation context**: every delivery attempt runs inside
  `withOrgContext(event.organisation_id, ...)` - the same invariant P0
  established for HTTP requests applies identically here. Cross-org
  discovery of _which_ orgs have due events uses a routing-only table with
  no RLS (`dispatch_queue`) - see `docs/decisions/0005-cross-org-background-enumeration.md`
  for why that's necessary and why it's safe (it carries no payload, only
  pointers).

All proven in `events.integration.spec.ts` (5/5) and exercised end-to-end
in the reference app test.

## Custom fields

`ctx.customFields.{getDefinitions,getValues,setValues}`. Storage is
canonical JSONB (`custom_field_values.values`); the _only_ code permitted
to write a raw `values->>'key'` path is
`CustomFieldQueryProvider`/`CustomFieldService` themselves
(`apps/api/src/platform/custom-fields/custom-field.service.ts`) - report/
filter code calls `expression()`/`filterCondition()`/`sortExpression()`/
`groupExpression()` and never constructs JSONB syntax itself (Architecture
§2.2). Writes are type-checked against the field's declared `fieldType`
before anything is persisted - `setValues` throws `BadRequestException`
for a mismatched type, an out-of-range select option, or an unknown key.
Field keys are restricted to `^[a-z][a-z0-9_]{0,63}$`. Values and
definitions are RLS-scoped per organisation like everything else - proven
in `custom-fields.integration.spec.ts` (10/10, including explicit
cross-org isolation checks).

## Forms

Declarative only. A definition is `{ sections: [{ key, label, fields: [...] }] }`
where each field has an allowlisted key set (`key, label, type, required,
helpText, defaultValue, options, conditional, permission`) and an
allowlisted `type`. `FormService.validateDefinitionShape` rejects any
unrecognised key or type - there is no way to embed executable
configuration. An app ships `defaultForms` in its manifest; Core seeds
them once (`FormService.seedDefault`, idempotent via `onConflict doNothing`);
an admin can subsequently call `FormService.customize` to replace the
definition, which is recorded via `is_customized`. `validateSubmission`
enforces required fields and `conditional` visibility. 7/7 tests in
`forms.integration.spec.ts`.

## Numbering

`ctx.numbering.next(db, sequenceKey)` returns a formatted identifier like
`WID-000001` or, with `yearReset: true`, `PO-2026-000001`. Concurrency
safety comes from a single atomic `UPDATE ... RETURNING` (Postgres's row
lock serializes concurrent callers) - **proven with a genuine 50-way
parallel-connection test**: zero duplicates, a fully contiguous
`1..50` sequence (`numbering.integration.spec.ts`). A sequence must be
registered (`NumberingService.registerSequence`, idempotent) before
`next()` can be called; calling `next()` on an unregistered sequence
throws rather than silently creating one. Sequences are organisation- and
app-scoped, so two orgs (or two apps) never collide even with the same
`sequenceKey`.

## Workflow

Declarative state machine: `{ states, initialState, transitions: [{ from,
to, permission, conditions?, requiredFields?, actions? }] }`. `actions` is
drawn from a fixed vocabulary (`{ kind: 'publish_event', eventType }`
only) - never executable code. `ctx.workflow.start(db, workflowKey,
entityType, entityId, actorId)` creates an instance; `ctx.workflow.transition(...)`
requires the actor to hold the transition's `permission`, evaluates any
`conditions` (simple field comparisons against a caller-supplied context
object) and `requiredFields`, and applies a **single atomic
`UPDATE ... WHERE id=$1 AND version=$2`** - a concurrent transition that
lost the race affects zero rows and gets a `ConflictException`, never a
silently corrupted/mixed state. Verified with a genuine two-way concurrent
transition race in `workflow.integration.spec.ts` (7/7, stable across
repeated runs).

## Approvals

`{ mode: 'sequential'|'parallel', steps: [{ approverPermission,
decisionRule: 'any_one_of'|'unanimous', requiredApproverCount? }] }`.
`ctx.approvals.requestApproval(...)` creates a request + one row per step;
`ctx.approvals.decide(db, stepId, deciderUserAccountId, decision, comment?)`
checks the decider holds the step's permission, enforces step ordering
under `sequential` mode, and resolves the step once its decision rule is
satisfied (a single decision for `any_one_of`, a configurable count of
_distinct_ approvers for `unanimous`). `approval_decisions` rows are
insert-only - no service method updates or deletes one, so the full
history is permanently auditable. Delegation
(`createDelegation`/`getActiveDelegators`) lets a delegate decide on a
delegator's behalf, recorded via `on_behalf_of`. 11/11 tests in
`approval.integration.spec.ts`.

## Checklists

`{ sections: [{ key, label, questions: [{ key, label, type, required,
options?, conditional?, scoreWeight?, flagsIssueOnFail? }] }] }`. Core
owns the mechanism (templates, instances, responses, weighted scoring at
completion, required-question and conditional-visibility enforcement);
applications own what a checklist _means_ - `resulting_issue_ref` is a
free-text pointer an app can set on a failed answer to link to its own
issue/ticket entity, with Core never needing to know that entity's shape.
4/4 tests in `checklist.integration.spec.ts`.

## Notifications

`ctx.notifications.send(db, recipientUserAccountId, notificationType,
title, body, relatedEntity?)`. Two channels ship in P1: `in_app` (a row
the frontend reads) and `email` (queued via structured logging, not an
actual SMTP send - no mail transport exists yet, same documented pattern
as P0's password-reset/invitation links). Per-user/type/channel
preferences (`setPreference`) can disable a channel. `markRead` is scoped
to the actual recipient - another user in the same organisation cannot
mark someone else's notification read. 4/4 tests in
`notifications.integration.spec.ts`.

## Files

`ctx.files.store(db, buffer, originalFilename, mimeType, uploadedBy,
entity?)`. `storage_key` is a random, server-generated identifier -
`original_filename` is retained purely as display metadata and is never
used to build a filesystem path. MIME type is validated against the
actual file bytes (magic-byte sniffing, `mime-sniff.ts`) - a declared type
that doesn't match its signature is rejected, not just filename/extension-
trusted. Retrieval and deletion are organisation-scoped (RLS + an explicit
check), so a correct file id from another organisation resolves to
not-found (IDOR-safe). Storage is behind a `StorageProvider` interface
(`LocalDiskStorageProvider` today; an S3-compatible provider is a drop-in
later). 8/8 tests in `files.integration.spec.ts`.

## Scheduling / background jobs

`ctx.scheduling.enqueue(db, jobType, payload, runAt?)`.
`organisationId` is a required parameter (mirroring `withOrgContext`'s own
rule) and the underlying column is `NOT NULL` - there is no way to
construct an org-less job. `JobRunnerService.runDue()` executes due jobs
inside `withOrgContext(job.organisation_id, ...)`, retries a failing
handler with backoff up to `max_attempts` (then marks it permanently
`failed`), and re-enqueues a recurring job's next occurrence on
completion. Cross-org discovery of due jobs uses the same `dispatch_queue`
routing table as events. 6/6 tests in `scheduling.integration.spec.ts`.

## Terminology

`ctx.terminology.resolve(db, termKey, fallback)` returns an
organisation-configured display override if one exists
(`TerminologyService.setOverride`), otherwise the app-supplied fallback.
This affects _display only_ - `termKey` remains the stable identifier
used everywhere else (API routes, permission keys, event names, migration
identifiers); nothing about changing a display override ever touches
those. 3/3 tests in `terminology.integration.spec.ts`.

## Input validation (API boundary)

Every controller uses a real `class`-based DTO with `class-validator`
decorators (`@IsString`, `@IsEmail`, `@IsInt` + `@Min`/`@Max`, `@IsUUID`,
etc), validated by a global `ValidationPipe`
(`whitelist: true, forbidNonWhitelisted: true, transform: true`) in
`main.ts`. This is the standard every future app's controllers are
expected to follow - **a plain TypeScript `interface` body type is not
validated at all** (interfaces erase to `Object` at runtime, so
`class-validator` has no metadata to read from them - this was a real gap
found and fixed during the P1 security review; see
`input-validation.integration.spec.ts` for the regression test). Malformed
input produces a structured 400 before any database work happens; an
unexpected body property is rejected outright (mass-assignment defense).

## What the SDK deliberately does NOT expose

- Raw database tables. No `HexyrnAppContext` method returns a Kysely query
  builder scoped to another app's or Core's own tables - only the
  narrow, typed operations listed above.
- Executable configuration of any kind - forms, workflows, and approvals
  are all validated against a fixed, allowlisted JSON shape; there is no
  "script" or "formula" field anywhere in the platform.
- A way to bypass `withOrgContext`/organisation scoping. Every SDK method
  that touches organisation-owned data takes the `db` handle the caller
  already has (from its own `withOrgContext` call) - there is no method
  that opens its own connection or infers an organisation.
