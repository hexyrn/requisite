-- Notification framework. P1 item 12. Applications request notifications
-- through Core (NotificationService.send) rather than emailing directly -
-- Core owns delivery/read-state/preferences. delivery_state is a small
-- per-channel JSON map ({"in_app":"delivered","email":"failed"}), not a
-- separate table per channel, since P1 only ships two channels.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  recipient_user_account_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  related_entity_type TEXT,
  related_entity_id UUID,
  channels TEXT[] NOT NULL DEFAULT '{in_app}',
  delivery_state JSONB NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notifications
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE INDEX ix_notifications_recipient ON notifications (organisation_id, recipient_user_account_id, created_at DESC);

CREATE TABLE notification_preferences (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_account_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (organisation_id, user_account_id, notification_type, channel)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notification_preferences
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
