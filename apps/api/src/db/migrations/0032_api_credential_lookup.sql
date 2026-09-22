-- API credential lookup routing table. P2 items 11/12 - the same
-- cross-org-discovery problem ADR 0005's dispatch_queue solves for the
-- event dispatcher and job runner: authenticating an inbound API request
-- happens BEFORE we know which organisation it belongs to, but
-- api_credentials is (correctly) RLS-protected, so it cannot be queried by
-- key_prefix alone without an org context already set - and the whole point
-- is we don't have one yet.
--
-- This table carries NO secret material (only a public key_prefix ->
-- organisation_id/credential_id pointer) and deliberately has NO RLS, exactly
-- like dispatch_queue - it is a routing index, not organisation-owned data.
-- Authentication flow: look up key_prefix here (no org context) to learn
-- WHICH organisation to open a context for, then verify the presented
-- secret's hash against api_credentials.secret_hash INSIDE that org's
-- withOrgContext - so the actual secret comparison still happens under RLS,
-- and a wrong/forged prefix simply fails to resolve to any row here.
CREATE TABLE api_credential_lookup (
  key_prefix TEXT PRIMARY KEY,
  organisation_id UUID NOT NULL,
  credential_id UUID NOT NULL,
  service_account_id UUID NOT NULL
);
