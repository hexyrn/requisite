-- Second reference-app table, deliberately created to prove cross-dataset
-- reporting with fan-out-safe aggregation (P2 items 5/26): one widget has
-- MANY notes, each carrying a numeric `note_value` - summing note_value
-- while also selecting widget fields is exactly the shape that would
-- silently inflate under a naive one-to-many join if the query engine
-- didn't pre-aggregate the many side first.
CREATE TABLE reference_widget_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  widget_id UUID NOT NULL REFERENCES reference_widgets(id) ON DELETE CASCADE,
  note_text TEXT NOT NULL,
  note_value NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reference_widget_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_widget_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON reference_widget_notes
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
