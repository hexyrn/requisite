-- Transactional event outbox. Architecture §9/§27 (carried forward), P1
-- item 4. `event_outbox` rows are inserted in the SAME transaction as the
-- domain change that caused them (standard outbox pattern: write your
-- business row and the event row atomically, then a separate dispatcher
-- delivers), so a crash between "domain write" and "event published" is
-- impossible - either both are in the transaction or neither is.
CREATE TABLE event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,           -- stable name, e.g. 'goods.received'
  event_version INT NOT NULL DEFAULT 1,
  producer_app_id TEXT NOT NULL,      -- 'com.hexyrn.core' or an installed app's id
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ           -- set once the dispatcher has handed this event to all registered consumers
);

ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON event_outbox
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

CREATE INDEX ix_event_outbox_undispatched ON event_outbox (created_at) WHERE dispatched_at IS NULL;

-- Consumer registration is installation-level (which app's code wants to
-- hear about which event type) - not org-scoped; whether that consumer
-- actually FIRES for a given org's event depends on the consuming app being
-- enabled+licensed+compatible for that org at dispatch time (checked by the
-- dispatcher, not encoded here).
CREATE TABLE event_consumer_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  consumer_app_id TEXT NOT NULL REFERENCES installed_applications(app_id) ON DELETE CASCADE,
  handler_ref TEXT NOT NULL,
  UNIQUE (event_type, consumer_app_id, handler_ref)
);

-- One delivery-attempt row per (event, consumer) - this is both the retry
-- ledger AND the idempotency guard: a consumer is never invoked twice for
-- the same event once a delivery row exists with status='delivered'.
CREATE TABLE event_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES event_outbox(id) ON DELETE CASCADE,
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  consumer_app_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed | skipped
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, consumer_app_id)
);

ALTER TABLE event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON event_deliveries
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
