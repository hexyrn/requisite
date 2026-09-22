-- Terminology mechanism. P1 item 7. Display-only overrides keyed by a
-- stable term_key; changing a row here never touches API routes,
-- permission keys, event names, or migration identifiers - those are
-- always the stable key, never this display value.
CREATE TABLE terminology_overrides (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  term_key TEXT NOT NULL,             -- stable, e.g. 'requisition'
  display_value TEXT NOT NULL,        -- e.g. 'Purchase Request'
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, app_id, term_key)
);

ALTER TABLE terminology_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminology_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON terminology_overrides
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
