ALTER TABLE school_settings
  ADD COLUMN logo_data bytea,
  ADD COLUMN logo_content_type text
    CHECK (logo_content_type IS NULL OR logo_content_type IN ('image/png', 'image/jpeg')),
  ADD COLUMN logo_updated_at timestamptz,
  ADD CONSTRAINT school_settings_logo_state_check CHECK (
    (logo_data IS NULL AND logo_content_type IS NULL AND logo_updated_at IS NULL)
    OR
    (logo_data IS NOT NULL AND logo_content_type IS NOT NULL AND logo_updated_at IS NOT NULL)
  );
