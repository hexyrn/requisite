-- Cross-organisation dispatch routing queue. Architectural note (see
-- docs/decisions/0005-cross-org-background-enumeration.md for the full
-- rationale): the event dispatcher and scheduled-job runner both need to
-- discover due work ACROSS organisations before they can enter
-- withOrgContext(organisationId, ...) for any one of them - but every
-- table holding actual event/job data is (correctly) RLS-protected with no
-- bypass role available to the app's connection. This table holds ONLY a
-- routing pointer (which org, which kind of work, which id, when it's due)
-- - never payload, never business data - so it is deliberately NOT
-- organisation-owned data, exactly like `installations`/`bootstrap_tokens`
-- (see their migration's header comment for the same reasoning), and
-- carries no RLS policy. The dispatcher/runner reads this table directly,
-- then re-enters withOrgContext(row.organisation_id, ...) to do all actual
-- protected work on the real event_outbox/scheduled_jobs row.
CREATE TABLE dispatch_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'event' | 'job'
  ref_id UUID NOT NULL,                -- event_outbox.id or scheduled_jobs.id
  due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,              -- set (briefly) while a worker is processing this entry
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id)
);

CREATE INDEX ix_dispatch_queue_due ON dispatch_queue (due_at) WHERE claimed_at IS NULL;
