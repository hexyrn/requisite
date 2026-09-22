-- com.hexyrn.reference's OWN domain table. P1 item 17. Deliberately tiny -
-- this table belongs to the reference app, not Core; Core has no idea what
-- a "widget" is, and no Core code ever queries this table directly. This
-- is here specifically to demonstrate the module-boundary principle: an
-- app owns its own business data, and reaches Core's mechanisms (custom
-- fields, numbering, workflow, approvals, events, notifications) only
-- through the App SDK context, never the other way around.
CREATE TABLE reference_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  widget_number TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reference_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON reference_widgets
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
