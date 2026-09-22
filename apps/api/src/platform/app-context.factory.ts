import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { HexyrnAppContext } from '@hexyrn/app-sdk';
import { Database } from '../db/types';
import { FlatRolePermissionEvaluator } from '../rbac/permission-evaluator';
import { CapabilityResolverService } from './capabilities/capability-resolver.service';
import { EventPublisherService } from './events/event-publisher.service';
import { CustomFieldService } from './custom-fields/custom-field.service';
import { NumberingService } from './numbering/numbering.service';
import { WorkflowService } from './workflow/workflow.service';
import { ApprovalService } from './approval/approval.service';
import { NotificationService } from './notifications/notification.service';
import { FileService } from './files/file.service';
import { ScheduledJobService } from './scheduling/scheduled-job.service';
import { TerminologyService } from './terminology/terminology.service';

/**
 * Builds the concrete `HexyrnAppContext` (from `@hexyrn/app-sdk`) that Core
 * hands to an app's own service/handler code, backed by the real platform
 * services. This is the ONE place the SDK's contract type is implemented -
 * every app (including the P1 reference app) receives this object and
 * never imports a platform service directly, exactly matching the
 * module-boundary rule ("app code never reaches into another app's - or
 * Core's own - internals directly").
 */
@Injectable()
export class AppContextFactory {
  constructor(
    private readonly capabilityResolver: CapabilityResolverService,
    private readonly eventPublisher: EventPublisherService,
    private readonly customFields: CustomFieldService,
    private readonly numbering: NumberingService,
    private readonly workflow: WorkflowService,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
    private readonly files: FileService,
    private readonly scheduling: ScheduledJobService,
    private readonly terminology: TerminologyService,
  ) {}

  create(appId: string, organisationId: string, grantedPermissions: ReadonlySet<string>, actorUserAccountId: string, requestDb: Kysely<Database>): HexyrnAppContext<Kysely<Database>> {
    const evaluator = new FlatRolePermissionEvaluator();

    return {
      appId,
      organisationId,

      permissions: {
        check: (permission, context) => evaluator.check({ userAccountId: actorUserAccountId, organisationId, grantedPermissions }, permission, context),
      },

      capabilities: {
        resolve: (capability) => this.capabilityResolver.resolve(requestDb, organisationId, capability),
      },

      events: {
        publish: (db, eventType, payload, version) => this.eventPublisher.publish(db, organisationId, appId, eventType, payload, version).then(() => undefined),
      },

      customFields: {
        getDefinitions: (db, entityType) => this.customFields.getDefinitions(db, organisationId, entityType),
        getValues: (db, entityType, entityId) => this.customFields.getValues(db, organisationId, entityType, entityId),
        setValues: (db, entityType, entityId, values) => this.customFields.setValues(db, organisationId, entityType, entityId, values),
      },

      numbering: {
        next: (db, sequenceKey) => this.numbering.next(db, organisationId, appId, sequenceKey),
      },

      workflow: {
        start: (db, workflowKey, entityType, entityId, actorId) =>
          this.workflow.startInstance(db, organisationId, appId, workflowKey, entityType, entityId, actorId).then((r) => ({ state: r.current_state })),
        transition: (db, entityType, entityId, toState, actorId) =>
          this.workflow.transition(db, organisationId, entityType, entityId, toState, grantedPermissions, actorId).then((r) => ({ state: r.state, version: r.version })),
      },

      approvals: {
        requestApproval: (db, definitionKey, entityType, entityId, context, requestedBy) =>
          this.approvals.requestApproval(db, organisationId, appId, definitionKey, entityType, entityId, context, requestedBy).then((r) => ({ requestId: r.id, status: r.status })),
        decide: (db, stepId, deciderUserAccountId, decision, comment) => this.approvals.decide(db, organisationId, stepId, deciderUserAccountId, grantedPermissions, decision, comment),
      },

      notifications: {
        send: (db, recipientUserAccountId, notificationType, title, body, relatedEntity) =>
          this.notifications.send(db, organisationId, appId, recipientUserAccountId, notificationType, title, body, relatedEntity).then(() => undefined),
      },

      files: {
        store: (db, buffer, originalFilename, mimeType, uploadedBy, entity) => this.files.store(db, organisationId, buffer, originalFilename, mimeType, uploadedBy, entity),
      },

      scheduling: {
        enqueue: (db, jobType, payload, runAt) => this.scheduling.enqueue(db, organisationId, appId, jobType, payload, runAt).then((jobId) => ({ jobId })),
      },

      terminology: {
        resolve: (db, termKey, fallback) => this.terminology.resolve(db, organisationId, appId, termKey, fallback),
      },
    };
  }
}
