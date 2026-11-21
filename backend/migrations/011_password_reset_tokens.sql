ALTER TABLE users
  ADD COLUMN password_reset_token_hash text UNIQUE,
  ADD COLUMN password_reset_expires_at timestamptz,
  ADD COLUMN password_reset_school_id uuid REFERENCES schools(id),
  ADD COLUMN password_reset_issued_by uuid REFERENCES users(id),
  ADD CONSTRAINT users_password_reset_state_check CHECK (
    (password_reset_token_hash IS NULL
      AND password_reset_expires_at IS NULL
      AND password_reset_school_id IS NULL
      AND password_reset_issued_by IS NULL)
    OR
    (password_reset_token_hash IS NOT NULL
      AND password_reset_expires_at IS NOT NULL
      AND password_reset_school_id IS NOT NULL
      AND password_reset_issued_by IS NOT NULL)
  );
