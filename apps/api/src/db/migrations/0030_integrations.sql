-- Integration framework. P2 items 16-20. `connector_registrations` is
-- installation-level (which connector implementations exist in this
-- build - com.hexyrn.connector.reference et al); everything else is
-- per-organisation configuration/state.
CREATE TABLE connector_registrations (
  connector_id TEXT PRIMARY KEY,         -- e.g. 'com.hexyrn.connector.reference'
  display_name TEXT NOT NULL,
  supported_entities TEXT[] NOT NULL,
  supported_directions TEXT[] NOT NULL,  -- subset of {inbound, outbound, bidirectional}
  config_schema JSONB NOT NULL DEFAULT '[]' -- [{ key, label, secret: bool, required: bool }]
);

CREATE TABLE integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connector_registrations(connector_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',        -- non-secret configuration
  config_secrets_encrypted JSONB NOT NULL DEFAULT '{}', -- secret configuration, AES-256-GCM-encrypted values
  status TEXT NOT NULL DEFAULT 'connected',  -- connected | disconnected | error
  last_error TEXT,
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON integration_connections
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- System of record / sync ownership. P2 item 18.
CREATE TABLE sync_ownership (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  direction TEXT NOT NULL,               -- external_to_hexyrn | hexyrn_to_external | bidirectional
  authoritative_system TEXT NOT NULL,    -- 'external' | 'hexyrn'
  conflict_resolution TEXT,              -- required (non-null) only when direction = 'bidirectional'
  PRIMARY KEY (connection_id, entity_type)
);

ALTER TABLE sync_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_ownership FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON sync_ownership
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Field mapping. P2 item 19. `transform` is an allowlisted keyword, never code.
CREATE TABLE field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  hexyrn_field TEXT NOT NULL,
  external_field TEXT NOT NULL,
  transform TEXT NOT NULL DEFAULT 'none', -- none | trim | uppercase | lowercase | to_string | to_number
  is_required BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON field_mappings
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Sync run infrastructure. P2 item 20.
CREATE TABLE sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  processed_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON sync_runs
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- External ID mapping - the deduplication/idempotency backbone every sync
-- run relies on: "have we seen this external record before, and what
-- Hexyrn row does it correspond to."
CREATE TABLE sync_external_ids (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  hexyrn_entity_id UUID NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, entity_type, external_id)
);

ALTER TABLE sync_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_external_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON sync_external_ids
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
