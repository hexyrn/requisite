import { Global, Module } from '@nestjs/common';
import { ApplicationRegistryService } from './app-registry/application-registry.service';
import { ApplicationActiveGuard } from './app-registry/application-active.guard';
import { CapabilityResolverService } from './capabilities/capability-resolver.service';
import { EventPublisherService } from './events/event-publisher.service';
import { EventHandlerRegistryService } from './events/event-handler-registry.service';
import { EventDispatcherService } from './events/event-dispatcher.service';
import { CustomFieldService } from './custom-fields/custom-field.service';
import { NumberingService } from './numbering/numbering.service';
import { FormService } from './forms/form.service';
import { TerminologyService } from './terminology/terminology.service';
import { WorkflowService } from './workflow/workflow.service';
import { ApprovalService } from './approval/approval.service';
import { ChecklistService } from './checklist/checklist.service';
import { NotificationService } from './notifications/notification.service';
import { FileService } from './files/file.service';
import { STORAGE_PROVIDER, LocalDiskStorageProvider } from './files/storage-provider';
import { ScheduledJobService, JobHandlerRegistryService } from './scheduling/scheduled-job.service';
import { JobRunnerService } from './scheduling/job-runner.service';
import { AppContextFactory } from './app-context.factory';
import { DatasetService } from './reporting/dataset.service';
import { ReportQueryService } from './reporting/report-query.service';
import { SavedReportService } from './reporting/saved-report.service';
import { DashboardService } from './dashboards/dashboard.service';
import { ExportService } from './exports/export.service';
import { ServiceAccountService } from './api-access/service-account.service';
import { EventSchemaService } from './events/event-schema.service';
import { WebhookService } from './webhooks/webhook.service';
import { WebhookDispatcherService } from './webhooks/webhook-dispatcher.service';
import { ScheduledReportService } from './reporting/scheduled-report.service';
import { SearchService } from './search/search.service';
import { ImportService } from './import/import.service';
import { ImportHandlerRegistryService } from './import/import-row-handler';
import { ConnectorRegistryService } from './integrations/connector-registry.service';
import { IntegrationConnectionService } from './integrations/integration-connection.service';
import { SyncAdapterRegistryService } from './integrations/sync-adapter-registry.service';
import { SyncHandlerRegistryService } from './integrations/sync-row-handler';
import { SyncEngineService } from './integrations/sync-engine.service';
import { DataPortabilityService } from './exports/data-portability.service';

/**
 * Every P1 platform mechanism in one Nest module, `@Global()` so any
 * feature/app module can inject these services without re-declaring the
 * whole provider list - the equivalent of "Core's runtime," parallel to
 * how P0's auth/session/rbac services were wired directly into
 * AppModule. Apps still only ever touch these THROUGH
 * `AppContextFactory`/`HexyrnAppContext`, never by importing this module's
 * exports directly for org-scoped work - the exports exist so Core's own
 * controllers (and the reference app's onboarding step) can use them.
 */
@Global()
@Module({
  providers: [
    ApplicationRegistryService,
    ApplicationActiveGuard,
    CapabilityResolverService,
    EventPublisherService,
    EventHandlerRegistryService,
    EventDispatcherService,
    CustomFieldService,
    NumberingService,
    FormService,
    TerminologyService,
    WorkflowService,
    ApprovalService,
    ChecklistService,
    NotificationService,
    FileService,
    { provide: STORAGE_PROVIDER, useValue: new LocalDiskStorageProvider() },
    ScheduledJobService,
    JobHandlerRegistryService,
    JobRunnerService,
    AppContextFactory,
    DatasetService,
    ReportQueryService,
    SavedReportService,
    DashboardService,
    ExportService,
    ServiceAccountService,
    EventSchemaService,
    WebhookService,
    WebhookDispatcherService,
    ScheduledReportService,
    SearchService,
    ImportService,
    ImportHandlerRegistryService,
    ConnectorRegistryService,
    IntegrationConnectionService,
    SyncAdapterRegistryService,
    SyncHandlerRegistryService,
    SyncEngineService,
    DataPortabilityService,
  ],
  exports: [
    ApplicationRegistryService,
    ApplicationActiveGuard,
    CapabilityResolverService,
    EventPublisherService,
    EventHandlerRegistryService,
    EventDispatcherService,
    CustomFieldService,
    NumberingService,
    FormService,
    TerminologyService,
    WorkflowService,
    ApprovalService,
    ChecklistService,
    NotificationService,
    FileService,
    STORAGE_PROVIDER,
    ScheduledJobService,
    JobHandlerRegistryService,
    JobRunnerService,
    AppContextFactory,
    DatasetService,
    ReportQueryService,
    SavedReportService,
    DashboardService,
    ExportService,
    ServiceAccountService,
    EventSchemaService,
    WebhookService,
    WebhookDispatcherService,
    ScheduledReportService,
    SearchService,
    ImportService,
    ImportHandlerRegistryService,
    ConnectorRegistryService,
    IntegrationConnectionService,
    SyncAdapterRegistryService,
    SyncHandlerRegistryService,
    SyncEngineService,
    DataPortabilityService,
  ],
})
export class PlatformModule {}
