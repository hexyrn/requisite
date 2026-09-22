-- Dashboard framework. P2 item 6. Widgets always resolve their data
-- through ReportQueryService (same permission-aware path as reports) -
-- there is no second analytics query path.
CREATE TABLE widget_definitions (
  widget_key TEXT PRIMARY KEY,           -- stable, e.g. 'core.people-count'
  app_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  widget_type TEXT NOT NULL,             -- kpi | table | bar_chart | line_chart | pie_chart | status_queue | alert_list
  dataset_key TEXT NOT NULL REFERENCES dataset_definitions(dataset_key) ON DELETE CASCADE,
  default_config JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  owner_user_account_id UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON dashboards
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE TABLE dashboard_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  widget_key TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',    -- query overrides (filters, dimension/measure choices) within widget_definitions' allowed shape
  position_x INT NOT NULL DEFAULT 0,
  position_y INT NOT NULL DEFAULT 0,
  width INT NOT NULL DEFAULT 4,
  height INT NOT NULL DEFAULT 3
);

ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON dashboard_widgets
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
