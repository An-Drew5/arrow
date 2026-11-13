DO $$
DECLARE
  target_school record;
  migration_007_applied_at timestamptz;
BEGIN
  SELECT applied_at INTO migration_007_applied_at
  FROM schema_migrations
  WHERE name = '007_jhs_core_subjects.sql';

  IF migration_007_applied_at IS NULL THEN
    RAISE EXCEPTION 'Migration 007_jhs_core_subjects.sql must be applied first';
  END IF;

  FOR target_school IN SELECT id FROM schools LOOP
    PERFORM set_config('app.school_id', target_school.id::text, true);
    UPDATE subjects subject
    SET is_core = true
    WHERE subject.school_id = target_school.id
      AND subject.is_core = false
      AND subject.created_at < migration_007_applied_at
      AND NOT EXISTS (
        SELECT 1
        FROM audit_log audit
        WHERE audit.school_id = subject.school_id
          AND audit.resource_type = 'subject'
          AND audit.resource_id = subject.id
          AND audit.action = 'subject.updated'
      )
      AND (
        btrim(regexp_replace(lower(subject.name), '[[:space:]]+', ' ', 'g'))
          LIKE 'english%'
        OR btrim(regexp_replace(lower(subject.name), '[[:space:]]+', ' ', 'g'))
          LIKE 'math%'
        OR btrim(regexp_replace(lower(subject.name), '[[:space:]]+', ' ', 'g'))
          LIKE 'integrated science%'
        OR btrim(regexp_replace(lower(subject.name), '[[:space:]]+', ' ', 'g'))
          LIKE 'social studies%'
        OR btrim(regexp_replace(lower(subject.name), '[[:space:]]+', ' ', 'g')) = 'science'
        OR btrim(regexp_replace(lower(subject.name), '[[:space:]]+', ' ', 'g'))
          LIKE 'science %'
      );
  END LOOP;
END $$;
