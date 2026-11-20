DO $$
DECLARE
  target_school record;
BEGIN
  FOR target_school IN SELECT id FROM schools LOOP
    PERFORM set_config('app.school_id', target_school.id::text, true);
    INSERT INTO role_permissions (school_id, role_id, permission)
    SELECT r.school_id, r.id, 'users:read'
    FROM roles r
    WHERE r.school_id = target_school.id AND r.name = 'school_admin'
    ON CONFLICT (school_id, role_id, permission) DO NOTHING;
  END LOOP;
END $$;
