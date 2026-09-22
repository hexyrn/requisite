-- Platform search + import framework. P2 items 9/10.
-- Search registration is installation-level (which entity types/fields an
-- app makes searchable); the search INDEX itself is org-scoped data.
CREATE TABLE search_entity_registrations (
  entity_type TEXT PRIMARY KEY,          -- e.g. 'core.person', 'reference.widget'
  app_id TEXT NOT NULL,
  required_permission TEXT NOT NULL,
  result_label_template TEXT NOT NULL,   -- e.g. '{title} ({widgetNumber})'
  result_destination_template TEXT NOT NULL -- e.g. '/reference/widgets/{id}'
);

CREATE TABLE search_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  search_text TEXT NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED,
  result_label TEXT NOT NULL,
  result_destination TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, entity_type, entity_id)
);

ALTER TABLE search_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_index FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON search_index
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE INDEX ix_search_index_vector ON search_index USING GIN (search_vector);

-- Import framework.
CREATE TABLE import_definitions (
  entity_type TEXT PRIMARY KEY,          -- e.g. 'reference.widget'
  app_id TEXT NOT NULL,
  required_permission TEXT NOT NULL,
  fields JSONB NOT NULL                  -- [{ key, label, required, fieldType }]
);

CREATE TABLE import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  requested_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  column_mapping JSONB NOT NULL DEFAULT '{}', -- { sourceColumn: fieldKey }
  status TEXT NOT NULL DEFAULT 'pending', -- pending | previewed | running | completed | failed
  total_rows INT,
  success_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  row_errors JSONB NOT NULL DEFAULT '[]', -- [{ rowNumber, error }]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_jobs
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
