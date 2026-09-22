-- Reporting dataset registry. Architecture §5/§11(Rev1), P2 item 1/2.
-- Applications register SEMANTIC datasets - never raw table access. A
-- dataset's `source_ref` is opaque to everyone except the report query
-- engine (ReportQueryService), which is the only code permitted to turn it
-- into an actual SQL FROM clause.
CREATE TABLE dataset_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key TEXT NOT NULL UNIQUE,      -- stable, e.g. 'core.people', 'reference.widgets'
  app_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  required_permission TEXT NOT NULL,
  source_ref TEXT NOT NULL,              -- opaque - which real table/view this maps to, known only to ReportQueryService
  fields JSONB NOT NULL,                 -- [{ key, label, fieldType, isDimension, isMeasure, aggregations[], filterable, sortable, groupable, searchable, classification, exportable }]
  is_exportable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Semantic relationships. Architecture §5. Only explicitly registered
-- relationships are traversable - no arbitrary joins.
CREATE TABLE dataset_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_dataset TEXT NOT NULL REFERENCES dataset_definitions(dataset_key) ON DELETE CASCADE,
  from_field TEXT NOT NULL,
  to_dataset TEXT NOT NULL REFERENCES dataset_definitions(dataset_key) ON DELETE CASCADE,
  to_field TEXT NOT NULL,
  cardinality TEXT NOT NULL,             -- one-to-one | many-to-one | one-to-many
  label TEXT NOT NULL,
  UNIQUE (from_dataset, from_field, to_dataset, to_field)
);

-- Saved report definitions. P2 item 4. org-scoped, RLS.
CREATE TABLE saved_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  owner_user_account_id UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  primary_dataset TEXT NOT NULL,
  definition JSONB NOT NULL,             -- { columns[], filters[], sort[], groupBy[], aggregations[], joins[] }
  visibility TEXT NOT NULL DEFAULT 'personal', -- personal | shared
  cloned_from_template_key TEXT,          -- if cloned from an app-registered default template
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE saved_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON saved_reports
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- App-registered default report templates - installation-level (not org
-- data), an org "clones" one into saved_reports via cloned_from_template_key.
CREATE TABLE report_templates (
  template_key TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  primary_dataset TEXT NOT NULL,
  definition JSONB NOT NULL
);
