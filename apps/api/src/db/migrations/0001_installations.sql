-- Installation: top-level entity above Organisation. Architecture §7.
-- Not itself organisation-owned data, so no RLS on this table.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  core_version TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time secure bootstrap token (Architecture §4 origin / P0 item 6).
-- Single-use: consumed_at is set permanently once the setup flow completes.
CREATE TABLE bootstrap_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);

-- Installation-level audit trail (events that happen before any organisation
-- exists, e.g. bootstrap completion). Organisation-scoped audit events live
-- in a separate table (see 0006_audit.sql) so RLS can apply cleanly there.
CREATE TABLE installation_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id UUID NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
