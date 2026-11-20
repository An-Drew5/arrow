ALTER TABLE subjects
  ADD COLUMN is_core boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  target_school record;
BEGIN
  FOR target_school IN SELECT id FROM schools LOOP
    PERFORM set_config('app.school_id', target_school.id::text, true);
    UPDATE subjects
    SET is_core = true
    WHERE school_id = target_school.id
      AND lower(btrim(name)) IN (
        'english',
        'mathematics',
        'integrated science',
        'science',
        'social studies'
      );
  END LOOP;
END $$;
