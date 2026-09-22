-- Workflow engine. P1 item 9. Declarative state machine: `definition` is
-- pure JSON (states, transitions with required permission/conditions/
-- required fields/actions) - never executable code, enforced at the
-- service layer. `workflow_instances.version` is the optimistic-concurrency
-- guard: every transition is `UPDATE ... WHERE id=$1 AND version=$2`, so
-- two concurrent transitions on the same instance can never both succeed -
-- the loser's UPDATE affects zero rows and the service raises a conflict
-- rather than silently corrupting state.
CREATE TABLE workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  definition JSONB NOT NULL,          -- { states: [...], transitions: [{from,to,permission,conditions,requiredFields,actions}] }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, app_id, workflow_key)
);

ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workflow_definitions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE workflow_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  current_state TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, entity_type, entity_id)
);

ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workflow_instances
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE workflow_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_user_account_id UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

ALTER TABLE workflow_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_history FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workflow_history
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
