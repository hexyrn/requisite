-- Organisational Units: configurable unit types, self-referencing hierarchy. P0 item 8.
CREATE TABLE organisational_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES organisational_units(id) ON DELETE SET NULL,
  unit_type TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE organisational_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisational_units FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organisational_units
  USING (organisation_id = current_setting('app.current_organisation_id', true)::uuid);

-- Locations: self-referencing hierarchical physical/logical locations. P0 item 9.
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  location_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON locations
  USING (organisation_id = current_setting('app.current_organisation_id', true)::uuid);
