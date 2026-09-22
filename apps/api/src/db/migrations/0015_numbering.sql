-- Numbering engine. P1 item 8. One row per (organisation, app, sequence
-- key); `current_value` is advanced with a single atomic UPDATE...RETURNING
-- (see NumberingService.next) - Postgres's row-level locking on UPDATE
-- serializes concurrent increments against the same row, so no explicit
-- SELECT FOR UPDATE or advisory lock is needed for correctness, only for
-- reduced contention (not required at P1's scale).
CREATE TABLE numbering_sequences (
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  sequence_key TEXT NOT NULL,          -- e.g. 'requisition', 'purchase_order'
  prefix TEXT NOT NULL DEFAULT '',
  pad_length INT NOT NULL DEFAULT 6,
  year_reset BOOLEAN NOT NULL DEFAULT false,
  current_value BIGINT NOT NULL DEFAULT 0,
  last_reset_year INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, app_id, sequence_key)
);

ALTER TABLE numbering_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE numbering_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON numbering_sequences
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
