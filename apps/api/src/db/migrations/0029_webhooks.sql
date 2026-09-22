-- Outbound webhooks. P2 item 14. `secret_hash` stores a hash for lookup/
-- rotation bookkeeping; the actual HMAC signing key is shown once at
-- creation/rotation, never re-displayed (same pattern as api_credentials).
CREATE TABLE webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  description TEXT,
  event_types TEXT[] NOT NULL DEFAULT '{}',
  secret_hash TEXT NOT NULL,             -- for verifying rotation history / admin reference only, not used to sign (signing key kept only in memory-safe env at issuance display time... see WebhookService for the real signing-key storage note)
  signing_key_encrypted TEXT NOT NULL,   -- encrypted at rest (same AES-256-GCM scheme as TOTP secrets) - needed at delivery time to compute the HMAC
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON webhook_endpoints
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,                -- event_outbox.id
  event_type TEXT NOT NULL,
  payload_version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  attempt_count INT NOT NULL DEFAULT 0,
  last_response_status INT,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON webhook_deliveries
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Event payload schemas. P2 item 15 - resolves the P1-deferred debt.
-- Installation-level (a schema belongs to the event TYPE, not an org).
CREATE TABLE event_schemas (
  event_type TEXT NOT NULL,
  version INT NOT NULL,
  app_id TEXT NOT NULL,
  schema JSONB NOT NULL,                 -- { required: string[], properties: { key: 'string'|'number'|'boolean'|'object'|'array' } } - minimal, allowlisted, no executable validation code
  PRIMARY KEY (event_type, version)
);
