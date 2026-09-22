-- Scheduling / background jobs. P1 item 14. `organisation_id` is NOT NULL
-- (never nullable) - mirrors withOrgContext's "no overload omitting
-- organisationId" rule at the schema level: a job row simply cannot be
-- constructed without an explicit organisation. The runner processes due
-- jobs with SELECT ... FOR UPDATE SKIP LOCKED so multiple worker
-- ticks/processes never double-execute the same job.
CREATE TABLE scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error TEXT,
  recurring_interval_seconds INT,      -- set for recurring jobs; re-enqueued on completion
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scheduled_jobs
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE INDEX ix_scheduled_jobs_due ON scheduled_jobs (run_at) WHERE status = 'pending';
