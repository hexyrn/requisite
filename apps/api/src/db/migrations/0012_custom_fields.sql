-- Custom field engine. Architecture §2 - schema exactly as specified there.
CREATE TABLE custom_field_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  help_text TEXT,
  field_type TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT false,
  default_value JSONB,
  validation JSONB,
  visibility TEXT NOT NULL DEFAULT 'visible', -- visible | hidden | read_only
  ordering INT NOT NULL DEFAULT 0,
  field_group TEXT,
  is_searchable BOOLEAN NOT NULL DEFAULT false,
  is_filterable BOOLEAN NOT NULL DEFAULT false,
  is_sortable BOOLEAN NOT NULL DEFAULT false,
  is_reportable BOOLEAN NOT NULL DEFAULT false,
  is_exportable BOOLEAN NOT NULL DEFAULT true,
  classification TEXT NOT NULL DEFAULT 'internal',
  select_options JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, app_id, entity_type, key)
);

ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON custom_field_definitions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE custom_field_values (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  values JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, entity_type, entity_id)
);

ALTER TABLE custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_values FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON custom_field_values
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE INDEX ix_cfv_values_gin ON custom_field_values USING GIN (values jsonb_path_ops);
