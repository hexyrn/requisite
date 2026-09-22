-- Secure shared file abstraction. P1 item 13. `storage_key` is a random,
-- server-generated identifier (never a client-supplied or derived path -
-- see FileService) used as the on-disk/on-bucket key; `original_filename`
-- is stored purely as display metadata and NEVER used to build a
-- filesystem path (prevents path traversal). No column here is ever
-- exposed as a public static URL - all access goes through an
-- access-controlled download endpoint.
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  uploaded_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON files
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
