-- Export framework audit trail + scheduled report delivery. P2 items 7/8/23.
CREATE TABLE export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  service_account_id UUID,               -- set instead of requested_by for API/service-account-initiated exports
  report_id UUID REFERENCES saved_reports(id) ON DELETE SET NULL,
  dataset_key TEXT NOT NULL,
  format TEXT NOT NULL,                  -- csv | xlsx | pdf
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
  approximate_row_count INT,
  file_ref TEXT,                         -- storage_key in `files`, once complete
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON export_jobs
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE scheduled_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  report_id UUID NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
  created_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  recipient_user_account_ids UUID[] NOT NULL DEFAULT '{}',
  formats TEXT[] NOT NULL DEFAULT '{csv}',
  cron_interval_seconds INT NOT NULL,    -- P2 minimal scheduling model: a fixed interval, reusing ScheduledJobService's recurring-job mechanism
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,                      -- success | failure
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scheduled_reports
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
