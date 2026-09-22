-- Service accounts / API credentials. P2 items 12/13. Same permission
-- model as human users (scopes map 1:1 onto the existing flat permission
-- strings, per item 13's "do not build a separate authorisation universe")
-- - a service account's granted_scopes are just permission keys.
CREATE TABLE service_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

ALTER TABLE service_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON service_accounts
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- API credentials: only a hash of the secret is ever stored, exactly like
-- password-reset/invitation tokens. The plaintext secret is shown to the
-- admin exactly once, at creation/rotation time, never again.
CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  service_account_id UUID NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,              -- first few chars of the plaintext key, shown in UI for identification only
  secret_hash TEXT NOT NULL,
  is_revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON api_credentials
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
