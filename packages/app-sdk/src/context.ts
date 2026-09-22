/**
 * HexyrnAppContext - the ONLY way application code touches Core
 * capabilities. Architecture's module-boundary rule ("app code never
 * reaches into another app's tables directly") extends here to Core
 * itself: an app's service code is handed this context object by Core's
 * App Registry/dispatcher, and never imports `apps/api/src/**` directly.
 *
 * `Db` is generic so this package has zero dependency on Core's internal
 * Kysely `Database` type map - Core parameterises it with its own type when
 * constructing a context for a handler; an app's own code only ever needs
 * `Db` as an opaque handle to pass to Core SDK calls that take one (e.g.
 * `events.publish(db, ...)`), never to query it directly for another app's
 * (or Core's own) tables.
 */
export interface HexyrnAppContext<Db = unknown> {
  readonly appId: string;
  readonly organisationId: string;

  permissions: {
    check(permission: string, context?: Record<string, unknown>): boolean;
  };

  capabilities: {
    resolve(capability: string): Promise<{ appId: string; serviceRef: string }[]>;
  };

  events: {
    publish(db: Db, eventType: string, payload: Record<string, unknown>, version?: number): Promise<void>;
  };

  customFields: {
    getDefinitions(db: Db, entityType: string): Promise<unknown[]>;
    getValues(db: Db, entityType: string, entityId: string): Promise<Record<string, unknown>>;
    setValues(db: Db, entityType: string, entityId: string, values: Record<string, unknown>): Promise<void>;
  };

  numbering: {
    next(db: Db, sequenceKey: string): Promise<string>;
  };

  workflow: {
    start(db: Db, workflowKey: string, entityType: string, entityId: string, actorUserAccountId?: string): Promise<{ state: string }>;
    transition(
      db: Db,
      entityType: string,
      entityId: string,
      toState: string,
      actorUserAccountId: string,
    ): Promise<{ state: string; version: number }>;
  };

  approvals: {
    requestApproval(
      db: Db,
      definitionKey: string,
      entityType: string,
      entityId: string,
      context: Record<string, unknown>,
      requestedBy: string,
    ): Promise<{ requestId: string; status: string }>;
    decide(
      db: Db,
      stepId: string,
      deciderUserAccountId: string,
      decision: 'approve' | 'reject',
      comment?: string,
    ): Promise<{ requestStatus: string; stepStatus: string }>;
  };

  notifications: {
    send(
      db: Db,
      recipientUserAccountId: string,
      notificationType: string,
      title: string,
      body: string,
      relatedEntity?: { type: string; id: string },
    ): Promise<void>;
  };

  files: {
    store(db: Db, buffer: Buffer, originalFilename: string, mimeType: string, uploadedBy: string, entity?: { type: string; id: string }): Promise<{ fileId: string }>;
  };

  scheduling: {
    enqueue(db: Db, jobType: string, payload: Record<string, unknown>, runAt?: Date): Promise<{ jobId: string }>;
  };

  terminology: {
    resolve(db: Db, termKey: string, fallback: string): Promise<string>;
  };
}
