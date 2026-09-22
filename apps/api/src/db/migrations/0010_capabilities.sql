-- Capability registry. Architecture §4. Registration is installation-level
-- (an installed app declares what it provides, regardless of org) -
-- resolution intersects this with per-org app_enablements/compatibility at
-- query time (see CapabilityResolver), so there is no per-org row here.
CREATE TABLE capability_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability TEXT NOT NULL,           -- '<domain>.<noun>.v<n>', e.g. 'purchasing.cost-source.v1'
  app_id TEXT NOT NULL REFERENCES installed_applications(app_id) ON DELETE CASCADE,
  service_ref TEXT NOT NULL,          -- opaque identifier the consuming app's SDK call resolves against
  UNIQUE (capability, app_id)
);

CREATE INDEX ix_capability_providers_capability ON capability_providers (capability);
