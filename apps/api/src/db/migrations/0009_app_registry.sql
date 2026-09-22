-- Application Registry. Architecture §3. installed_applications is
-- installation-level (an app's code/manifest is present in this build,
-- regardless of organisation) - no RLS, same reasoning as `installations`.
-- app_enablements and application_licenses are per-organisation - RLS.
CREATE TABLE installed_applications (
  app_id TEXT PRIMARY KEY,             -- reverse-DNS, e.g. 'com.hexyrn.requisite'
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,               -- semver, independent of Core's version
  major_version INT NOT NULL,
  requires_core_version TEXT NOT NULL, -- semver range
  description TEXT,
  manifest JSONB NOT NULL DEFAULT '{}', -- full HexyrnAppManifest, retained verbatim
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enabled: an administrator has turned this app on for THIS organisation.
-- Independent of installed/licensed/compatible per Architecture §3.
CREATE TABLE app_enablements (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES installed_applications(app_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  PRIMARY KEY (organisation_id, app_id)
);

ALTER TABLE app_enablements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_enablements FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON app_enablements
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Licensed: Architecture §9. P1 implements the three-property model
-- (license / compatibility / support) with a SIMPLIFIED verification step -
-- see docs/decisions for the exact scope note (no real asymmetric signature
-- verification is performed in P1; license_payload's "signature" field is
-- checked for presence/shape only). This is documented, not silent.
CREATE TABLE application_licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES installed_applications(app_id) ON DELETE CASCADE,
  licensed_major_version INT NOT NULL,
  license_payload JSONB NOT NULL,
  signature_valid_at TIMESTAMPTZ NOT NULL,
  support_expires_at TIMESTAMPTZ,
  UNIQUE (organisation_id, app_id, licensed_major_version)
);

ALTER TABLE application_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_licenses FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON application_licenses
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
