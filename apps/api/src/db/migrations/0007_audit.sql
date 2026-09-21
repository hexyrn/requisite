-- Audit framework: structured, append-only. P0 item 21.
-- Never write secrets/passwords/tokens into metadata - enforced at the
-- service layer (AuditService), see src/audit/audit.service.ts.
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_account_id UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  entity_type TEXT,
  entity_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_events
  USING (organisation_id = current_setting('app.current_organisation_id', true)::uuid);

CREATE INDEX ix_audit_events_org_created ON audit_events (organisation_id, created_at DESC);
