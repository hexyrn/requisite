-- Approval engine. P1 item 10. Declarative definitions (safe rules only -
-- condition matching against a fixed context shape, never an executable
-- rules language). approval_decisions rows are immutable (no UPDATE/DELETE
-- exposed by the service layer - only INSERT), so every decision is
-- permanently auditable.
CREATE TABLE approval_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  definition_key TEXT NOT NULL,
  definition JSONB NOT NULL,          -- { steps: [{ mode: sequential|parallel|any_one_of|unanimous, approverPermission, condition }] }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, app_id, definition_key)
);

ALTER TABLE approval_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON approval_definitions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  definition_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  context JSONB NOT NULL DEFAULT '{}', -- amount, organisationalUnitId, locationId, requesterId, category, supplierId, costObjectId, customFields...
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  requested_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (organisation_id, entity_type, entity_id)
);

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON approval_requests
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE approval_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  mode TEXT NOT NULL,                 -- sequential_gate | parallel | any_one_of | unanimous
  approver_permission TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | skipped
  UNIQUE (request_id, step_index)
);

ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON approval_steps
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES approval_steps(id) ON DELETE CASCADE,
  decided_by UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,             -- approve | reject
  comment TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  on_behalf_of UUID REFERENCES user_accounts(id) ON DELETE SET NULL -- set when decided via delegation
);

ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON approval_decisions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Delegation foundation: while active, `delegate_user_id` may decide steps
-- routed to `delegator_user_id` (approval_decisions.on_behalf_of records this).
CREATE TABLE approval_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  delegator_user_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  delegate_user_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ
);

ALTER TABLE approval_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_delegations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON approval_delegations
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
