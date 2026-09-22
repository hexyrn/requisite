-- BUGFIX (found via empirical testing against real Postgres, not assumed):
-- current_setting('app.current_organisation_id', true) returns NULL only on
-- a connection that has NEVER had `SET LOCAL app.current_organisation_id`
-- issued on it. On a connection that HAS run a SET LOCAL for that GUC at
-- least once (i.e. almost every pooled connection after its first org-scoped
-- request), the setting reverts to '' (empty string), not NULL, once the
-- transaction that set it ends. Our original policies cast this straight to
-- ::uuid, so a subsequent query with no org context on a "warmed" connection
-- throws a Postgres error (22P02 invalid input syntax for type uuid)
-- instead of cleanly returning zero rows. This is still fail-closed from a
-- data-exposure standpoint (nothing is ever returned), but it turns "no org
-- context" into a 500 rather than an empty result set, which is not what
-- Architecture §8's "current_setting(..., true) returning NULL" language
-- describes and is worth being exact about.
--
-- Fix: NULLIF(..., '') turns '' into NULL before the cast, so a missing OR
-- reverted-to-empty context both resolve to NULL::uuid, and the policy's
-- equality check against NULL is never true - zero rows, no error, on every
-- table, on both fresh and reused connections.

ALTER POLICY org_isolation ON organisations
  USING (id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON organisational_units
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON locations
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON people
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON user_accounts
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON mfa_recovery_codes
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON sessions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON password_reset_tokens
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON invitations
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON roles
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON role_permissions
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON user_roles
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

ALTER POLICY org_isolation ON audit_events
  USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
