ALTER TABLE classes
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived'));

CREATE INDEX classes_school_status_idx ON classes (school_id, status);
