# Build Your First Hexyrn App

A walkthrough of `com.hexyrn.reference` - the P1 reference application -
showing exactly how a real app is built on Hexyrn Core through the App
SDK. Every file referenced here exists in this repository; every claim is
backed by `apps/api/src/apps/reference/__tests__/reference-app.e2e.integration.spec.ts`,
which drives the whole thing over real HTTP against real Postgres.

The reference app manages a tiny "widget" entity that goes through a
create → submit → approve/reject lifecycle. It is deliberately small - not
a template for a real product, just a proof that the boundaries hold.

## 1. Declare the manifest

`apps/api/src/apps/reference/reference.manifest.ts` exports a
`HexyrnAppManifest`:

```ts
export const REFERENCE_APP_MANIFEST: HexyrnAppManifest = {
  appId: 'com.hexyrn.reference',
  displayName: 'Hexyrn Reference App',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^0.1.0',
  permissions: [
    { key: 'reference.widget.view', label: 'View widgets' },
    { key: 'reference.widget.create', label: 'Create widgets' },
    { key: 'reference.widget.submit', label: 'Submit widgets for approval' },
    { key: 'reference.widget.approve', label: 'Approve widgets' },
  ],
  navigation: [{ key: 'reference-widgets', label: 'Reference Widgets', path: '/reference/widgets', permission: 'reference.widget.view' }],
  capabilities: [{ capability: 'reference.thing.v1', provides: { serviceRef: 'ReferenceThingService' } }],
  eventsPublished: [{ eventType: 'reference.widget.approved', version: 1, description: '...' }],
  numberingSequences: [{ sequenceKey: 'widget', prefix: 'WID-', padLength: 6 }],
  defaultForms: [ /* a 'widget.create' form with a required title */ ],
  defaultWorkflows: [ /* draft -> submitted -> approved/rejected */ ],
};
```

This is pure data. Nothing here runs code.

## 2. Register it at boot

`main.ts` calls `registerReferenceApp(registry)` once, at process start -
the same thing every compiled-in app does (Architecture §3 v1 packaging:
apps are workspace packages compiled into one build; the loader's job is
"given manifest+code, register and boot it"). This writes one row to
`installed_applications` and the app's declared capability providers to
`capability_providers`. **Installed** does not mean active - see lifecycle
below.

## 3. Give the app its own table

`apps/api/src/db/migrations/0023_reference_app.sql` creates
`reference_widgets` - organisation-scoped, RLS-protected, exactly like
every Core table. This is the app's own business data. Core has no idea
what a "widget" is and no Core code ever queries this table. This is the
module-boundary principle made concrete: an app owns its data, Core owns
the mechanism.

## 4. Write the business logic against `HexyrnAppContext`

`apps/api/src/apps/reference/reference.service.ts`'s `createWidget` method:

```ts
async createWidget(ctx: HexyrnAppContext<Kysely<Database>>, db, actorUserAccountId, title, warrantyStatus?) {
  const widgetNumber = await ctx.numbering.next(db, 'widget');          // Numbering
  const row = await db.insertInto('reference_widgets').values({ ... }); // the app's OWN table
  if (warrantyStatus) {
    await ctx.customFields.setValues(db, 'reference_widget', row.id, { warranty_status: warrantyStatus }); // Custom fields
  }
  await ctx.workflow.start(db, 'widget-approval', 'reference_widget', row.id, actorUserAccountId); // Workflow
  return this.getWidget(db, ctx.organisationId, row.id);
}
```

Notice: `reference.service.ts` never imports `NumberingService`,
`CustomFieldService`, or `WorkflowService`. It only ever sees `ctx`. The
only import from `platform/` in this file is for the *onboarding* step
(seeding this org's default form/workflow/numbering sequence, which by
nature is a registration-time operation, not a runtime SDK call - see the
comment on `onboardOrganisation` in that file).

## 5. Get the context from Core

`apps/api/src/apps/reference/reference.controller.ts`:

```ts
@RequirePermission('reference.widget.create')
@Post()
async create(@Req() req, @Body() body: CreateWidgetDto) {
  const organisationId = req.currentOrganisationId; // set by SessionAuthGuard
  const subject = req.permissionSubject;             // set by SessionAuthGuard
  const actor = req.currentUser;

  return withOrgContext(organisationId, (db) => {
    const ctx = this.contextFactory.create('com.hexyrn.reference', organisationId, subject.grantedPermissions, actor.id, db);
    return this.reference.createWidget(ctx, db, actor.id, body.title, body.warrantyStatus);
  });
}
```

`AppContextFactory.create(...)` (`apps/api/src/platform/app-context.factory.ts`)
is the one place in the entire codebase that builds a real
`HexyrnAppContext` from the platform services. Every route follows this
same shape: resolve org + session (already done by the global guards),
enter `withOrgContext`, build a context, call into the app's own service.

## 6. Gate the routes

```ts
@Controller('api/v1/apps/reference/widgets')
@BelongsToApp('com.hexyrn.reference')
export class ReferenceController { ... }
```

`@BelongsToApp` + the globally-registered `ApplicationActiveGuard` means
every route in this controller 404s outright if the app isn't
installed+enabled+licensed+compatible for the caller's organisation -
before `@RequirePermission` even runs. Proven directly:
`reference-app.e2e.integration.spec.ts`'s "APP INACTIVITY" test disables
the app mid-suite and confirms even the *organisation owner* gets a 404,
not a 403, on a route they'd otherwise have full permission to use.

## 7. Run the lifecycle

```
POST /api/v1/apps/reference/widgets           { title, warrantyStatus } -> creates, numbers, starts workflow ("draft")
POST /api/v1/apps/reference/widgets/:id/submit                          -> workflow -> "submitted", opens an approval request
POST /api/v1/apps/reference/widgets/:id/decide { stepId, decision }     -> approval decided; if approved, workflow -> "approved"
                                                                              AND ctx.events.publish('reference.widget.approved', ...)
GET  /api/v1/apps/reference/widgets/:id                                 -> current state + custom field values
```

Approving a widget publishes an event. Any other installed, active app
that declared `eventsConsumed: [{ eventType: 'reference.widget.approved', handlerRef }]`
in its own manifest and registered a handler function
(`EventHandlerRegistryService.register(handlerRef, fn)`) receives it,
inside `withOrgContext` for the correct organisation, with retry and
idempotency guarantees it gets for free. This is exactly the "Requisite
publishes `goods.received`; Assets consumes it if installed/enabled"
pattern Architecture §4/§9 describes, and it's tested with a real second
app in the reference test's final case.

## 8. Try it yourself

```bash
npm run migrate --workspace apps/api
npm run dev:api
```

On boot, `com.hexyrn.reference` is registered automatically. Complete
bootstrap (see `docs/BOOTSTRAP.md`), then as the owner:

```bash
# enable + license the app for your org (no admin UI for this yet in P1 -
# it's exercised via ApplicationRegistryService directly in tests/scripts)
# then:
curl -X POST http://localhost:3000/api/v1/apps/reference/widgets \
  -H "Content-Type: application/json" -H "X-Hexyrn-CSRF: <token>" \
  --cookie "hexyrn_session=<...>" \
  -d '{"title":"My First Widget","warrantyStatus":"active"}'
```

## What this proves

Everything in `docs/APP_SDK.md`'s per-mechanism sections works, and -
critically - works *together*, through the same boundary a real
commercial app (Requisite, Assets, ...) would use: manifest declaration,
lifecycle gating, permission checks, numbering, custom fields, forms,
workflow, approvals, and events, all reached only through
`HexyrnAppContext`, never by reaching into Core's internals.
