-- RBAC: permissions as namespaced strings, roles as permission collections,
-- many-to-many user<->role. Explicitly NO scope-condition table - Architecture §1
-- defers that as a designed extension point, not built in v1. P0 item 17.
CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON roles
  USING (organisation_id = current_setting('app.current_organisation_id', true)::uuid);

CREATE TABLE role_permissions (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON role_permissions
  USING (organisation_id = current_setting('app.current_organisation_id', true)::uuid);

CREATE TABLE user_roles (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_account_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_account_id, role_id)
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON user_roles
  USING (organisation_id = current_setting('app.current_organisation_id', true)::uuid);
