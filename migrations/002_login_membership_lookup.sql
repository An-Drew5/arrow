-- Login must list a user's memberships before a school context exists.
-- This SELECT-only policy exposes memberships for the transaction-local login user.
-- When the setting is unset, it matches no rows and tenant isolation is unchanged.
CREATE POLICY login_membership_read ON memberships
  FOR SELECT
  USING (
    user_id = NULLIF(current_setting('app.login_user_id', true), '')::uuid
  );