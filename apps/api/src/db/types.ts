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
}
