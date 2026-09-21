-- Organisation entity. Architecture §7, P0 item 7.
-- Deliberately no UK-specific defaults (locale/timezone/currency are all
-- required inputs at creation time, not schema-level defaults).
CREATE TABLE organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  logo_file_ref TEXT,
  default_currency TEXT NOT NULL,
  timezone TEXT NOT NULL,
  locale TEXT NOT NULL,
  financial_year_start_month INT NOT NULL CHECK (financial_year_start_month BETWEEN 1 AND 12),
  address JSONB NOT NULL DEFAULT '{}',
  contact JSONB NOT NULL DEFAULT '{}',
  preferences JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: organisations is organisation-owned data keyed by its own id.
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organisations
  USING (id = current_setting('app.current_organisation_id', true)::uuid);
