import { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface InstallationsTable {
  id: Generated<string>;
  core_version: string;
  config: Generated<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
}

export interface BootstrapTokensTable {
  id: Generated<string>;
  installation_id: string;
  token_hash: string;
  created_at: Generated<Timestamp>;
  consumed_at: Timestamp | null;
}

export interface InstallationAuditEventsTable {
  id: Generated<string>;
  installation_id: string;
  event_type: string;
  metadata: Generated<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
}

export interface OrganisationsTable {
  id: string;
  installation_id: string;
  name: string;
  display_name: string;
  logo_file_ref: string | null;
  default_currency: string;
  timezone: string;
  locale: string;
  financial_year_start_month: number;
  address: Generated<Record<string, unknown>>;
  contact: Generated<Record<string, unknown>>;
  preferences: Generated<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface OrganisationalUnitsTable {
  id: Generated<string>;
  organisation_id: string;
  parent_id: string | null;
  unit_type: string;
  name: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface LocationsTable {
  id: Generated<string>;
  organisation_id: string;
  parent_id: string | null;
  name: string;
  location_type: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface PeopleTable {
  id: Generated<string>;
  organisation_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  organisational_unit_id: string | null;
  location_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface UserAccountsTable {
  id: Generated<string>;
  organisation_id: string;
  person_id: string | null;
  email: string;
  password_hash: string;
  is_active: Generated<boolean>;
  is_owner: Generated<boolean>;
  mfa_enabled: Generated<boolean>;
  totp_secret_encrypted: string | null;
  failed_login_count: Generated<number>;
  locked_until: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface MfaRecoveryCodesTable {
  id: Generated<string>;
  organisation_id: string;
  user_account_id: string;
  code_hash: string;
  used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface SessionsTable {
  id: Generated<string>;
  organisation_id: string;
  user_account_id: string;
  csrf_token: string;
  mfa_verified: Generated<boolean>;
  created_at: Generated<Timestamp>;
  last_seen_at: Generated<Timestamp>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface PasswordResetTokensTable {
  id: Generated<string>;
  organisation_id: string;
  user_account_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface InvitationsTable {
  id: Generated<string>;
  organisation_id: string;
  email: string;
  token_hash: string;
  invited_by_user_account_id: string | null;
  role_ids: Generated<string[]>;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface RolesTable {
  id: Generated<string>;
  organisation_id: string;
  name: string;
  is_system_role: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface RolePermissionsTable {
  organisation_id: string;
  role_id: string;
  permission_key: string;
}

export interface UserRolesTable {
  organisation_id: string;
  user_account_id: string;
  role_id: string;
}

export interface AuditEventsTable {
  id: Generated<string>;
  organisation_id: string;
  event_type: string;
  actor_user_account_id: string | null;
  entity_type: string | null;
  entity_ref: string | null;
  metadata: Generated<Record<string, unknown>>;
  correlation_id: string | null;
  created_at: Generated<Timestamp>;
}

// ---- P1: Application Registry (§3) ----
export interface InstalledApplicationsTable {
  app_id: string;
  display_name: string;
  version: string;
  major_version: number;
  requires_core_version: string;
  description: string | null;
  manifest: Generated<Record<string, unknown>>;
  installed_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AppEnablementsTable {
  organisation_id: string;
  app_id: string;
  enabled: Generated<boolean>;
  enabled_at: Timestamp | null;
  disabled_at: Timestamp | null;
}

export interface ApplicationLicensesTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  licensed_major_version: number;
  license_payload: Record<string, unknown>;
  signature_valid_at: Timestamp;
  support_expires_at: Timestamp | null;
}

// ---- P1: Capability Registry (§4) ----
export interface CapabilityProvidersTable {
  id: Generated<string>;
  capability: string;
  app_id: string;
  service_ref: string;
}

// ---- P1: Event Outbox ----
export interface EventOutboxTable {
  id: Generated<string>;
  organisation_id: string;
  event_type: string;
  event_version: Generated<number>;
  producer_app_id: string;
  payload: Generated<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
  dispatched_at: Timestamp | null;
}

export interface EventConsumerRegistrationsTable {
  id: Generated<string>;
  event_type: string;
  consumer_app_id: string;
  handler_ref: string;
}

export interface EventDeliveriesTable {
  id: Generated<string>;
  event_id: string;
  organisation_id: string;
  consumer_app_id: string;
  status: Generated<string>;
  attempt_count: Generated<number>;
  last_error: string | null;
  delivered_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

// ---- P1: Custom Fields (§2) ----
export interface CustomFieldDefinitionsTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  entity_type: string;
  key: string;
  label: string;
  help_text: string | null;
  field_type: string;
  is_required: Generated<boolean>;
  default_value: unknown | null;
  validation: Record<string, unknown> | null;
  visibility: Generated<string>;
  ordering: Generated<number>;
  field_group: string | null;
  is_searchable: Generated<boolean>;
  is_filterable: Generated<boolean>;
  is_sortable: Generated<boolean>;
  is_reportable: Generated<boolean>;
  is_exportable: Generated<boolean>;
  classification: Generated<string>;
  select_options: unknown | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CustomFieldValuesTable {
  organisation_id: string;
  entity_type: string;
  entity_id: string;
  values: Generated<Record<string, unknown>>;
  updated_at: Generated<Timestamp>;
}

// ---- P1: Forms ----
export interface FormDefinitionsTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  form_key: string;
  label: string;
  definition: Record<string, unknown>;
  is_customized: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// ---- P1: Terminology ----
export interface TerminologyOverridesTable {
  organisation_id: string;
  app_id: string;
  term_key: string;
  display_value: string;
  updated_at: Generated<Timestamp>;
}

// ---- P1: Numbering ----
export interface NumberingSequencesTable {
  organisation_id: string;
  app_id: string;
  sequence_key: string;
  prefix: Generated<string>;
  pad_length: Generated<number>;
  year_reset: Generated<boolean>;
  current_value: Generated<string>; // bigint comes back as string from pg
  last_reset_year: number | null;
  created_at: Generated<Timestamp>;
}

// ---- P1: Workflow ----
export interface WorkflowDefinitionsTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  workflow_key: string;
  definition: Record<string, unknown>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface WorkflowInstancesTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  workflow_key: string;
  entity_type: string;
  entity_id: string;
  current_state: string;
  version: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface WorkflowHistoryTable {
  id: Generated<string>;
  organisation_id: string;
  instance_id: string;
  from_state: string | null;
  to_state: string;
  actor_user_account_id: string | null;
  occurred_at: Generated<Timestamp>;
  metadata: Generated<Record<string, unknown>>;
}

// ---- P1: Approval ----
export interface ApprovalDefinitionsTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  definition_key: string;
  definition: Record<string, unknown>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ApprovalRequestsTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  definition_key: string;
  entity_type: string;
  entity_id: string;
  context: Generated<Record<string, unknown>>;
  status: Generated<string>;
  requested_by: string | null;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

export interface ApprovalStepsTable {
  id: Generated<string>;
  organisation_id: string;
  request_id: string;
  step_index: number;
  mode: string;
  approver_permission: string;
  status: Generated<string>;
}

export interface ApprovalDecisionsTable {
  id: Generated<string>;
  organisation_id: string;
  step_id: string;
  decided_by: string;
  decision: string;
  comment: string | null;
  decided_at: Generated<Timestamp>;
  on_behalf_of: string | null;
}

export interface ApprovalDelegationsTable {
  id: Generated<string>;
  organisation_id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  starts_at: Generated<Timestamp>;
  ends_at: Timestamp | null;
}

// ---- P1: Checklists ----
export interface ChecklistTemplatesTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  template_key: string;
  label: string;
  definition: Record<string, unknown>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ChecklistInstancesTable {
  id: Generated<string>;
  organisation_id: string;
  template_id: string;
  entity_type: string;
  entity_id: string;
  status: Generated<string>;
  started_by: string | null;
  started_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
  score: number | null;
}

export interface ChecklistResponsesTable {
  id: Generated<string>;
  organisation_id: string;
  instance_id: string;
  question_key: string;
  value: unknown;
  resulting_issue_ref: string | null;
  answered_by: string | null;
  answered_at: Generated<Timestamp>;
}

// ---- P1: Notifications ----
export interface NotificationsTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  recipient_user_account_id: string;
  notification_type: string;
  title: string;
  body: string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  channels: Generated<string[]>;
  delivery_state: Generated<Record<string, unknown>>;
  read_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface NotificationPreferencesTable {
  organisation_id: string;
  user_account_id: string;
  notification_type: string;
  channel: string;
  enabled: Generated<boolean>;
}

// ---- P1: Files ----
export interface FilesTable {
  id: Generated<string>;
  organisation_id: string;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: string; // bigint -> string
  entity_type: string | null;
  entity_id: string | null;
  uploaded_by: string | null;
  created_at: Generated<Timestamp>;
}

// ---- P1: reference app's own domain table ----
export interface ReferenceWidgetsTable {
  id: Generated<string>;
  organisation_id: string;
  widget_number: string;
  title: string;
  created_by: string | null;
  created_at: Generated<Timestamp>;
}

export interface ReferenceWidgetNotesTable {
  id: Generated<string>;
  organisation_id: string;
  widget_id: string;
  note_text: string;
  note_value: Generated<string>; // numeric -> string
  created_at: Generated<Timestamp>;
}

// ---- P1: Cross-org dispatch routing (no RLS - see ADR 0005) ----
export interface DispatchQueueTable {
  id: Generated<string>;
  organisation_id: string;
  kind: string;
  ref_id: string;
  due_at: Generated<Timestamp>;
  claimed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

// ---- P1: Scheduling ----
export interface ScheduledJobsTable {
  id: Generated<string>;
  organisation_id: string;
  app_id: string;
  job_type: string;
  payload: Generated<Record<string, unknown>>;
  run_at: Generated<Timestamp>;
  status: Generated<string>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  last_error: string | null;
  recurring_interval_seconds: number | null;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

// ---- P2: Reporting ----
export interface DatasetDefinitionsTable {
  id: Generated<string>;
  dataset_key: string;
  app_id: string;
  display_name: string;
  description: string | null;
  required_permission: string;
  source_ref: string;
  fields: unknown;
  is_exportable: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface DatasetRelationshipsTable {
  id: Generated<string>;
  from_dataset: string;
  from_field: string;
  to_dataset: string;
  to_field: string;
  cardinality: string;
  label: string;
}

export interface SavedReportsTable {
  id: Generated<string>;
  organisation_id: string;
  owner_user_account_id: string | null;
  name: string;
  primary_dataset: string;
  definition: unknown;
  visibility: Generated<string>;
  cloned_from_template_key: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ReportTemplatesTable {
  template_key: string;
  app_id: string;
  name: string;
  primary_dataset: string;
  definition: unknown;
}

// ---- P2: Dashboards ----
export interface WidgetDefinitionsTable {
  widget_key: string;
  app_id: string;
  display_name: string;
  widget_type: string;
  dataset_key: string;
  default_config: Generated<Record<string, unknown>>;
}

export interface DashboardsTable {
  id: Generated<string>;
  organisation_id: string;
  owner_user_account_id: string | null;
  name: string;
  is_default: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface DashboardWidgetsTable {
  id: Generated<string>;
  organisation_id: string;
  dashboard_id: string;
  widget_key: string;
  config: Generated<Record<string, unknown>>;
  position_x: Generated<number>;
  position_y: Generated<number>;
  width: Generated<number>;
  height: Generated<number>;
}

// ---- P2: Exports / Scheduled Reports ----
export interface ExportJobsTable {
  id: Generated<string>;
  organisation_id: string;
  requested_by: string | null;
  service_account_id: string | null;
  report_id: string | null;
  dataset_key: string;
  format: string;
  status: Generated<string>;
  approximate_row_count: number | null;
  file_ref: string | null;
  error: string | null;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

export interface ScheduledReportsTable {
  id: Generated<string>;
  organisation_id: string;
  report_id: string;
  created_by: string | null;
  recipient_user_account_ids: Generated<string[]>;
  formats: Generated<string[]>;
  cron_interval_seconds: number;
  enabled: Generated<boolean>;
  last_run_at: Timestamp | null;
  last_status: string | null;
  created_at: Generated<Timestamp>;
}

// ---- P2: Search / Import ----
export interface SearchEntityRegistrationsTable {
  entity_type: string;
  app_id: string;
  required_permission: string;
  result_label_template: string;
  result_destination_template: string;
}

export interface SearchIndexTable {
  id: Generated<string>;
  organisation_id: string;
  entity_type: string;
  entity_id: string;
  search_text: string;
  result_label: string;
  result_destination: string;
  updated_at: Generated<Timestamp>;
}

export interface ImportDefinitionsTable {
  entity_type: string;
  app_id: string;
  required_permission: string;
  fields: unknown;
}

export interface ImportJobsTable {
  id: Generated<string>;
  organisation_id: string;
  entity_type: string;
  requested_by: string | null;
  column_mapping: Generated<Record<string, unknown>>;
  status: Generated<string>;
  total_rows: number | null;
  success_count: Generated<number>;
  error_count: Generated<number>;
  row_errors: Generated<unknown[]>;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

// ---- P2: Service Accounts / API Credentials ----
export interface ServiceAccountsTable {
  id: Generated<string>;
  organisation_id: string;
  name: string;
  description: string | null;
  is_enabled: Generated<boolean>;
  granted_scopes: Generated<string[]>;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  last_used_at: Timestamp | null;
}

export interface ApiCredentialsTable {
  id: Generated<string>;
  organisation_id: string;
  service_account_id: string;
  key_prefix: string;
  secret_hash: string;
  is_revoked: Generated<boolean>;
  created_at: Generated<Timestamp>;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
}

// ---- P2: Webhooks / Event Schemas ----
export interface WebhookEndpointsTable {
  id: Generated<string>;
  organisation_id: string;
  url: string;
  description: string | null;
  event_types: Generated<string[]>;
  secret_hash: string;
  signing_key_encrypted: string;
  is_enabled: Generated<boolean>;
  created_by: string | null;
  created_at: Generated<Timestamp>;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  organisation_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload_version: Generated<number>;
  status: Generated<string>;
  attempt_count: Generated<number>;
  last_response_status: number | null;
  last_error: string | null;
  delivered_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface EventSchemasTable {
  event_type: string;
  version: number;
  app_id: string;
  schema: unknown;
}

// ---- P2: Integrations ----
export interface ConnectorRegistrationsTable {
  connector_id: string;
  display_name: string;
  supported_entities: string[];
  supported_directions: string[];
  config_schema: Generated<unknown[]>;
}

export interface IntegrationConnectionsTable {
  id: Generated<string>;
  organisation_id: string;
  connector_id: string;
  display_name: string;
  config: Generated<Record<string, unknown>>;
  config_secrets_encrypted: Generated<Record<string, unknown>>;
  status: Generated<string>;
  last_error: string | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
}

export interface SyncOwnershipTable {
  organisation_id: string;
  connection_id: string;
  entity_type: string;
  direction: string;
  authoritative_system: string;
  conflict_resolution: string | null;
}

export interface FieldMappingsTable {
  id: Generated<string>;
  organisation_id: string;
  connection_id: string;
  entity_type: string;
  hexyrn_field: string;
  external_field: string;
  transform: Generated<string>;
  is_required: Generated<boolean>;
}

export interface SyncRunsTable {
  id: Generated<string>;
  organisation_id: string;
  connection_id: string;
  entity_type: string;
  direction: string;
  status: Generated<string>;
  processed_count: Generated<number>;
  success_count: Generated<number>;
  failure_count: Generated<number>;
  errors: Generated<unknown[]>;
  started_at: Generated<Timestamp>;
  ended_at: Timestamp | null;
}

export interface SyncExternalIdsTable {
  organisation_id: string;
  connection_id: string;
  entity_type: string;
  external_id: string;
  hexyrn_entity_id: string;
  last_synced_at: Generated<Timestamp>;
}

export interface Database {
  installations: InstallationsTable;
  bootstrap_tokens: BootstrapTokensTable;
  installation_audit_events: InstallationAuditEventsTable;
  organisations: OrganisationsTable;
  organisational_units: OrganisationalUnitsTable;
  locations: LocationsTable;
  people: PeopleTable;
  user_accounts: UserAccountsTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  sessions: SessionsTable;
  password_reset_tokens: PasswordResetTokensTable;
  invitations: InvitationsTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  audit_events: AuditEventsTable;
  installed_applications: InstalledApplicationsTable;
  app_enablements: AppEnablementsTable;
  application_licenses: ApplicationLicensesTable;
  capability_providers: CapabilityProvidersTable;
  event_outbox: EventOutboxTable;
  event_consumer_registrations: EventConsumerRegistrationsTable;
  event_deliveries: EventDeliveriesTable;
  custom_field_definitions: CustomFieldDefinitionsTable;
  custom_field_values: CustomFieldValuesTable;
  form_definitions: FormDefinitionsTable;
  terminology_overrides: TerminologyOverridesTable;
  numbering_sequences: NumberingSequencesTable;
  workflow_definitions: WorkflowDefinitionsTable;
  workflow_instances: WorkflowInstancesTable;
  workflow_history: WorkflowHistoryTable;
  approval_definitions: ApprovalDefinitionsTable;
  approval_requests: ApprovalRequestsTable;
  approval_steps: ApprovalStepsTable;
  approval_decisions: ApprovalDecisionsTable;
  approval_delegations: ApprovalDelegationsTable;
  checklist_templates: ChecklistTemplatesTable;
  checklist_instances: ChecklistInstancesTable;
  checklist_responses: ChecklistResponsesTable;
  notifications: NotificationsTable;
  notification_preferences: NotificationPreferencesTable;
  files: FilesTable;
  scheduled_jobs: ScheduledJobsTable;
  dispatch_queue: DispatchQueueTable;
  reference_widgets: ReferenceWidgetsTable;
  reference_widget_notes: ReferenceWidgetNotesTable;
  dataset_definitions: DatasetDefinitionsTable;
  dataset_relationships: DatasetRelationshipsTable;
  saved_reports: SavedReportsTable;
  report_templates: ReportTemplatesTable;
  widget_definitions: WidgetDefinitionsTable;
  dashboards: DashboardsTable;
  dashboard_widgets: DashboardWidgetsTable;
  export_jobs: ExportJobsTable;
  scheduled_reports: ScheduledReportsTable;
  search_entity_registrations: SearchEntityRegistrationsTable;
  search_index: SearchIndexTable;
  import_definitions: ImportDefinitionsTable;
  import_jobs: ImportJobsTable;
  service_accounts: ServiceAccountsTable;
  api_credentials: ApiCredentialsTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  event_schemas: EventSchemasTable;
  connector_registrations: ConnectorRegistrationsTable;
  integration_connections: IntegrationConnectionsTable;
  sync_ownership: SyncOwnershipTable;
  field_mappings: FieldMappingsTable;
  sync_runs: SyncRunsTable;
  sync_external_ids: SyncExternalIdsTable;
}
