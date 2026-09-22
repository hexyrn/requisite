-- Configurable form engine. P1 item 6. Applications ship a default
-- definition (stored here at enablement time, app_id-owned); admins may
-- then customize sections/fields/visibility - the row is simply updated.
-- Definitions are declarative JSON (sections/fields/conditions), never
-- executable code - enforced at the service layer (FormService validates
-- shape, never eval()s anything).
CREATE TABLE form_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  form_key TEXT NOT NULL,             -- stable identifier, e.g. 'requisition.create'
  label TEXT NOT NULL,                -- display label, independent of form_key
  definition JSONB NOT NULL,          -- { sections: [{ key, label, fields: [...] }] }
  is_customized BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, app_id, form_key)
);

ALTER TABLE form_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON form_definitions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
