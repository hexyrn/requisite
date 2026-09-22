-- Checklist engine. P1 item 11. Core owns the mechanism (templates,
-- sections, questions, responses); applications own what a checklist
-- MEANS (an inspection, a goods-receipt QA check, etc - out of Core's
-- concern). `resulting_issue_ref` is a deliberately extensible free-text
-- pointer so an application can link a failed question to its own
-- issue/ticket entity without Core needing to know that entity's shape.
CREATE TABLE checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  label TEXT NOT NULL,
  definition JSONB NOT NULL,          -- { sections: [{ key, label, questions: [{key,label,type,required,options,scoring,conditional}] }] }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, app_id, template_key)
);

ALTER TABLE checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON checklist_templates
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE checklist_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | completed
  started_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  score NUMERIC
);

ALTER TABLE checklist_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON checklist_instances
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE checklist_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  instance_id UUID NOT NULL REFERENCES checklist_instances(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  value JSONB NOT NULL,
  resulting_issue_ref TEXT,
  answered_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instance_id, question_key)
);

ALTER TABLE checklist_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON checklist_responses
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
