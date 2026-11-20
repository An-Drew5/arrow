ALTER TABLE schools
  ADD COLUMN address text,
  ADD COLUMN phone text,
  ADD COLUMN email text,
  ADD COLUMN district_directorate text,
  ADD COLUMN headteacher_name text;

ALTER TABLE terms
  ADD COLUMN vacation_date date,
  ADD COLUMN next_term_begins date;

ALTER TABLE enrollments
  ADD COLUMN roll_number integer,
  ADD COLUMN start_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN end_date date;

UPDATE enrollments e
SET start_date = ay.start_date
FROM academic_years ay
WHERE ay.school_id = e.school_id AND ay.id = e.academic_year_id;

WITH numbered AS (
  SELECT e.school_id, e.id,
    row_number() OVER (
      PARTITION BY e.school_id, e.class_id
      ORDER BY s.last_name, s.first_name, s.admission_no, e.id
    ) AS roll_number
  FROM enrollments e
  JOIN students s ON s.school_id = e.school_id AND s.id = e.student_id
)
UPDATE enrollments e
SET roll_number = numbered.roll_number
FROM numbered
WHERE e.school_id = numbered.school_id AND e.id = numbered.id;

ALTER TABLE enrollments
  ALTER COLUMN roll_number SET NOT NULL,
  ADD CONSTRAINT enrollments_dates_ordered CHECK (end_date IS NULL OR start_date <= end_date);
CREATE UNIQUE INDEX enrollments_school_class_roll_idx
  ON enrollments (school_id, class_id, roll_number) WHERE status = 'active';
CREATE SEQUENCE student_admission_no_seq;
GRANT USAGE, SELECT ON SEQUENCE student_admission_no_seq TO arrow_app;

ALTER TABLE teacher_assignments
  ADD COLUMN assignment_type text NOT NULL DEFAULT 'subject';
UPDATE teacher_assignments
SET assignment_type = CASE WHEN subject_id IS NULL THEN 'class_teacher' ELSE 'subject' END;
ALTER TABLE teacher_assignments
  ADD CONSTRAINT teacher_assignments_type_check
    CHECK (assignment_type IN ('subject', 'class_teacher', 'all_subjects')),
  ADD CONSTRAINT teacher_assignments_subject_type_check
    CHECK ((assignment_type = 'subject' AND subject_id IS NOT NULL)
      OR (assignment_type IN ('class_teacher', 'all_subjects') AND subject_id IS NULL));

CREATE TABLE school_settings (
  school_id uuid PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  position_basis text NOT NULL DEFAULT 'best_n'
    CHECK (position_basis IN ('best_n', 'all_subjects')),
  aggregate_subject_count smallint NOT NULL DEFAULT 6
    CHECK (aggregate_subject_count BETWEEN 1 AND 12),
  pass_mark smallint NOT NULL DEFAULT 40 CHECK (pass_mark BETWEEN 0 AND 100),
  late_counts_as_present boolean NOT NULL DEFAULT true,
  sba_exam_gap_threshold smallint NOT NULL DEFAULT 30
    CHECK (sba_exam_gap_threshold BETWEEN 0 AND 100),
  report_scale_kinds jsonb NOT NULL DEFAULT
    '{"primary":["letter","proficiency"],"jhs":["number"]}'::jsonb
    CHECK (jsonb_typeof(report_scale_kinds) = 'object')
);
CREATE INDEX school_settings_school_idx ON school_settings (school_id);

INSERT INTO school_settings (school_id)
SELECT id FROM schools
ON CONFLICT (school_id) DO NOTHING;

CREATE TABLE student_subject_opt_outs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  student_id uuid NOT NULL,
  class_subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_id, class_subject_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, class_subject_id) REFERENCES class_subjects (school_id, id)
);
CREATE INDEX student_subject_opt_outs_school_class_subject_idx
  ON student_subject_opt_outs (school_id, class_subject_id, student_id);

ALTER TABLE grading_schemes
  ADD COLUMN sba_weight numeric(5,2),
  ADD COLUMN exam_max_mark numeric(8,1) NOT NULL DEFAULT 100;
UPDATE grading_schemes SET sba_weight = class_score_weight;
ALTER TABLE grading_schemes
  ALTER COLUMN sba_weight SET NOT NULL,
  ADD CONSTRAINT grading_schemes_sba_weight_check
    CHECK (sba_weight >= 0 AND sba_weight + exam_weight = 100),
  ADD CONSTRAINT grading_schemes_exam_max_mark_check CHECK (exam_max_mark > 0);

CREATE TABLE scheme_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  scheme_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sba', 'exam')),
  max_mark numeric(8,1) NOT NULL CHECK (max_mark > 0),
  sort_order smallint NOT NULL CHECK (sort_order >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, scheme_id)
    REFERENCES grading_schemes (school_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX scheme_components_active_name_idx
  ON scheme_components (school_id, scheme_id, name) WHERE is_active;
CREATE UNIQUE INDEX scheme_components_active_sort_idx
  ON scheme_components (school_id, scheme_id, sort_order) WHERE is_active;
CREATE INDEX scheme_components_school_scheme_idx
  ON scheme_components (school_id, scheme_id, sort_order);

CREATE TABLE grading_scales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  scheme_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('letter', 'proficiency', 'number', 'overall_comment')),
  metric text NOT NULL CHECK (metric IN ('subject_total', 'average')),
  lower_is_better boolean NOT NULL DEFAULT false,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, scheme_id, kind),
  UNIQUE (school_id, scheme_id, id),
  FOREIGN KEY (school_id, scheme_id)
    REFERENCES grading_schemes (school_id, id) ON DELETE CASCADE
);
CREATE INDEX grading_scales_school_scheme_idx ON grading_scales (school_id, scheme_id);

ALTER TABLE grade_bands
  ADD COLUMN scale_id uuid;
ALTER TABLE grade_bands
  DROP CONSTRAINT grade_bands_school_id_scheme_id_label_key,
  ADD CONSTRAINT grade_bands_scale_fk
    FOREIGN KEY (school_id, scheme_id, scale_id)
    REFERENCES grading_scales (school_id, scheme_id, id) ON DELETE CASCADE;
CREATE UNIQUE INDEX grade_bands_school_scale_label_idx
  ON grade_bands (school_id, scale_id, label) WHERE scale_id IS NOT NULL;
CREATE INDEX grade_bands_school_scale_score_idx
  ON grade_bands (school_id, scale_id, min_score, max_score);

ALTER TABLE assessments
  ADD COLUMN scheme_component_id uuid;
ALTER TABLE assessments
  ADD CONSTRAINT assessments_component_fk
    FOREIGN KEY (school_id, scheme_component_id)
    REFERENCES scheme_components (school_id, id);
CREATE UNIQUE INDEX assessments_school_term_component_idx
  ON assessments (school_id, term_id, class_id, subject_id, scheme_component_id)
  WHERE scheme_component_id IS NOT NULL;
CREATE INDEX assessments_school_component_idx
  ON assessments (school_id, scheme_component_id);

ALTER TABLE term_results
  ADD COLUMN sba_raw numeric(8,1),
  ADD COLUMN sba_max numeric(8,1),
  ADD COLUMN exam_raw numeric(8,1),
  ADD COLUMN exam_max numeric(8,1),
  ADD COLUMN sba_scaled smallint,
  ADD COLUMN exam_scaled smallint,
  ADD COLUMN subject_position integer,
  ADD COLUMN grades jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN incomplete_reason text;
ALTER TABLE term_results
  ADD CONSTRAINT term_results_grades_object_check CHECK (jsonb_typeof(grades) = 'object');

ALTER TABLE score_versions
  ADD COLUMN old_status text CHECK (old_status IS NULL OR old_status IN ('scored', 'absent', 'excused')),
  ADD COLUMN new_status text CHECK (new_status IS NULL OR new_status IN ('scored', 'absent', 'excused')),
  ADD COLUMN client_id uuid;
CREATE UNIQUE INDEX score_versions_school_client_idx
  ON score_versions (school_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE term_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  academic_year_id uuid NOT NULL,
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  term_id uuid NOT NULL,
  results_complete smallint NOT NULL DEFAULT 0 CHECK (results_complete >= 0),
  total_raw integer NOT NULL DEFAULT 0 CHECK (total_raw >= 0),
  out_of integer NOT NULL DEFAULT 0 CHECK (out_of >= 0),
  average smallint,
  aggregate integer,
  overall_position integer,
  subjects_passed smallint NOT NULL DEFAULT 0 CHECK (subjects_passed >= 0),
  subjects_failed smallint NOT NULL DEFAULT 0 CHECK (subjects_failed >= 0),
  class_enrolment integer NOT NULL DEFAULT 0 CHECK (class_enrolment >= 0),
  overall_comment text,
  scheme_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_id, term_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, academic_year_id, class_id)
    REFERENCES classes (school_id, academic_year_id, id),
  FOREIGN KEY (school_id, academic_year_id, term_id)
    REFERENCES terms (school_id, academic_year_id, id)
);
CREATE INDEX term_summaries_school_class_term_idx
  ON term_summaries (school_id, class_id, term_id, aggregate DESC);
CREATE INDEX term_summaries_school_student_term_idx
  ON term_summaries (school_id, student_id, term_id);

CREATE TABLE attendance_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  academic_year_id uuid NOT NULL,
  class_id uuid NOT NULL,
  register_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  taken_by uuid NOT NULL,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, class_id, register_date),
  FOREIGN KEY (school_id, academic_year_id, class_id)
    REFERENCES classes (school_id, academic_year_id, id),
  FOREIGN KEY (school_id, taken_by) REFERENCES memberships (school_id, id),
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
);
CREATE INDEX attendance_registers_school_class_date_idx
  ON attendance_registers (school_id, class_id, register_date DESC);

ALTER TABLE attendance
  ADD COLUMN register_id uuid,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE attendance
  ADD CONSTRAINT attendance_register_fk
    FOREIGN KEY (school_id, register_id)
    REFERENCES attendance_registers (school_id, id) ON DELETE CASCADE;
CREATE INDEX attendance_school_register_student_idx
  ON attendance (school_id, register_id, student_id);

CREATE TABLE attendance_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  attendance_id uuid NOT NULL,
  old_status text CHECK (old_status IS NULL OR old_status IN ('present', 'absent', 'late', 'excused')),
  new_status text NOT NULL CHECK (new_status IN ('present', 'absent', 'late', 'excused')),
  changed_by uuid NOT NULL,
  client_id uuid NOT NULL,
  reason text,
  entered_at timestamptz,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, attendance_id) REFERENCES attendance (school_id, id),
  FOREIGN KEY (school_id, changed_by) REFERENCES memberships (school_id, id)
);
CREATE UNIQUE INDEX attendance_versions_school_client_idx
  ON attendance_versions (school_id, client_id);
CREATE INDEX attendance_versions_school_attendance_changed_idx
  ON attendance_versions (school_id, attendance_id, changed_at DESC);

CREATE TABLE school_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  CHECK (start_date <= end_date)
);
CREATE INDEX school_closures_school_dates_idx
  ON school_closures (school_id, start_date, end_date);

CREATE TABLE term_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  term_id uuid NOT NULL,
  days_present smallint NOT NULL CHECK (days_present >= 0),
  days_open smallint NOT NULL CHECK (days_open >= 0),
  source text NOT NULL CHECK (source IN ('computed', 'imported')),
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_id, term_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES classes (school_id, id),
  FOREIGN KEY (school_id, term_id) REFERENCES terms (school_id, id),
  CHECK (days_present <= days_open)
);
CREATE INDEX term_attendance_school_term_class_idx
  ON term_attendance (school_id, term_id, class_id);

ALTER TABLE import_jobs
  DROP CONSTRAINT import_jobs_kind_check,
  ADD CONSTRAINT import_jobs_kind_check
    CHECK (kind IN ('students', 'historical_results', 'attendance_totals'));

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'school_settings', 'student_subject_opt_outs', 'scheme_components',
    'grading_scales', 'term_summaries', 'attendance_registers',
    'school_closures', 'term_attendance', 'attendance_versions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)',
      tenant_table
    );
  END LOOP;
END $$;

DO $$
DECLARE
  school record;
BEGIN
  FOR school IN SELECT id FROM schools LOOP
    PERFORM set_config('app.school_id', school.id::text, true);

    INSERT INTO role_permissions (school_id, role_id, permission)
    SELECT r.school_id, r.id, p.permission
    FROM roles r
    CROSS JOIN unnest(ARRAY[
      'school:manage', 'academics:manage', 'users:manage', 'roles:manage',
      'audit:read', 'students:read', 'students:write', 'scores:read',
      'scores:write', 'attendance:read', 'attendance:write', 'analytics:read',
      'grading:manage', 'settings:manage', 'results:compute', 'terms:lock',
      'reports:read', 'imports:run'
    ]::text[]) AS p(permission)
    WHERE r.school_id = school.id AND r.name = 'school_admin' AND r.is_system
    ON CONFLICT DO NOTHING;

    DELETE FROM role_permissions rp
    USING roles r
    WHERE rp.school_id = school.id AND rp.role_id = r.id
      AND r.name = 'headteacher' AND r.is_system
      AND rp.permission NOT IN (
        'students:read', 'scores:read', 'attendance:read',
        'reports:read', 'results:compute', 'terms:lock'
      );
    INSERT INTO role_permissions (school_id, role_id, permission)
    SELECT r.school_id, r.id, p.permission
    FROM roles r
    CROSS JOIN unnest(ARRAY[
      'students:read', 'scores:read', 'attendance:read',
      'reports:read', 'results:compute', 'terms:lock'
    ]::text[]) AS p(permission)
    WHERE r.school_id = school.id AND r.name = 'headteacher' AND r.is_system
    ON CONFLICT DO NOTHING;

    DELETE FROM role_permissions rp
    USING roles r
    WHERE rp.school_id = school.id AND rp.role_id = r.id
      AND r.name = 'records_officer' AND r.is_system
      AND rp.permission NOT IN ('students:read', 'students:write', 'attendance:read', 'imports:run');
    INSERT INTO role_permissions (school_id, role_id, permission)
    SELECT r.school_id, r.id, p.permission
    FROM roles r
    CROSS JOIN unnest(ARRAY[
      'students:read', 'students:write', 'attendance:read', 'imports:run'
    ]::text[]) AS p(permission)
    WHERE r.school_id = school.id AND r.name = 'records_officer' AND r.is_system
    ON CONFLICT DO NOTHING;

    DELETE FROM role_permissions rp
    USING roles r
    WHERE rp.school_id = school.id AND rp.role_id = r.id
      AND r.name = 'subject_teacher' AND r.is_system
      AND rp.permission NOT IN ('students:read', 'scores:read', 'scores:write');
    INSERT INTO role_permissions (school_id, role_id, permission)
    SELECT r.school_id, r.id, p.permission
    FROM roles r
    CROSS JOIN unnest(ARRAY[
      'students:read', 'scores:read', 'scores:write'
    ]::text[]) AS p(permission)
    WHERE r.school_id = school.id AND r.name = 'subject_teacher' AND r.is_system
    ON CONFLICT DO NOTHING;

    DELETE FROM role_permissions rp
    USING roles r
    WHERE rp.school_id = school.id AND rp.role_id = r.id
      AND r.name = 'class_teacher' AND r.is_system
      AND rp.permission NOT IN (
        'students:read', 'scores:read', 'attendance:read', 'attendance:write'
      );
    INSERT INTO role_permissions (school_id, role_id, permission)
    SELECT r.school_id, r.id, p.permission
    FROM roles r
    CROSS JOIN unnest(ARRAY[
      'students:read', 'scores:read', 'attendance:read', 'attendance:write'
    ]::text[]) AS p(permission)
    WHERE r.school_id = school.id AND r.name = 'class_teacher' AND r.is_system
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  school_settings, student_subject_opt_outs, scheme_components, grading_scales,
  term_summaries, attendance_registers, school_closures, term_attendance,
  attendance_versions
TO arrow_app;

DO $$
DECLARE
  school record;
  current_scheme_id uuid;
  current_scale_id uuid;
  item record;
BEGIN
  FOR school IN SELECT id FROM schools LOOP
    PERFORM set_config('app.school_id', school.id::text, true);

    UPDATE grading_schemes
    SET is_default = false
    WHERE school_id = school.id AND name IN ('Primary A-F', 'JHS nine-point');

    INSERT INTO grading_schemes (
      school_id, name, description, level_from, level_to, scale_type,
      lower_is_better, class_score_weight, sba_weight, exam_weight,
      exam_max_mark, is_default
    ) VALUES
      (school.id, 'Primary scheme',
       'Editable default; not verified against an official GES document. Default for Primary Basic 1-6.',
       1, 6, 'percentage_bands', false, 50, 50, 50, 100, true),
      (school.id, 'JHS scheme',
       'Editable default; not verified against an official GES document. Uses the same components pending a JHS sample.',
       7, 9, 'percentage_bands', true, 50, 50, 50, 100, true)
    ON CONFLICT (school_id, name) DO NOTHING;

    FOR item IN
      SELECT * FROM (VALUES
        ('Primary scheme', 'Class exercise', 'sba', 15::numeric, 1::smallint),
        ('Primary scheme', 'Group work', 'sba', 15::numeric, 2::smallint),
        ('Primary scheme', 'Class test', 'sba', 15::numeric, 3::smallint),
        ('Primary scheme', 'Project work', 'sba', 15::numeric, 4::smallint),
        ('Primary scheme', 'Exam', 'exam', 100::numeric, 5::smallint),
        ('JHS scheme', 'Class exercise', 'sba', 15::numeric, 1::smallint),
        ('JHS scheme', 'Group work', 'sba', 15::numeric, 2::smallint),
        ('JHS scheme', 'Class test', 'sba', 15::numeric, 3::smallint),
        ('JHS scheme', 'Project work', 'sba', 15::numeric, 4::smallint),
        ('JHS scheme', 'Exam', 'exam', 100::numeric, 5::smallint)
      ) AS components(scheme_name, component_name, component_kind, maximum, ordering)
    LOOP
      SELECT id INTO current_scheme_id FROM grading_schemes
      WHERE school_id = school.id AND name = item.scheme_name;
      INSERT INTO scheme_components (
        school_id, scheme_id, name, kind, max_mark, sort_order
      ) VALUES (
        school.id, current_scheme_id, item.component_name, item.component_kind, item.maximum, item.ordering
      ) ON CONFLICT DO NOTHING;
    END LOOP;

    FOR item IN
      SELECT * FROM (VALUES
        ('Primary scheme', 'Letter grade', 'letter', 'subject_total', false,
         'Editable default; not verified against an official GES document.'),
        ('Primary scheme', 'Proficiency', 'proficiency', 'subject_total', false,
         'Editable default; not verified against an official GES document. These cut-offs are to be confirmed against the official scale.'),
        ('Primary scheme', 'Overall comment', 'overall_comment', 'average', false,
         'Editable default; not verified against an official GES document.'),
        ('JHS scheme', 'Nine-point grade', 'number', 'subject_total', true,
         'Editable default; not verified against an official GES document.'),
        ('JHS scheme', 'Overall comment', 'overall_comment', 'average', false,
         'Editable default; not verified against an official GES document. Uses the primary overall-comment scale until a JHS sample is available.')
      ) AS scales(scheme_name, scale_name, scale_kind, scale_metric, lower_better, scale_description)
    LOOP
      SELECT id INTO current_scheme_id FROM grading_schemes
      WHERE school_id = school.id AND name = item.scheme_name;
      INSERT INTO grading_scales (
        school_id, scheme_id, name, kind, metric, lower_is_better, description
      ) VALUES (
        school.id, current_scheme_id, item.scale_name, item.scale_kind, item.scale_metric,
        item.lower_better, item.scale_description
      ) ON CONFLICT (school_id, scheme_id, kind) DO NOTHING;
    END LOOP;

    FOR item IN
      SELECT * FROM (VALUES
        ('Primary scheme', 'letter', 90, 100, 'A+', 9::numeric, 'Outstanding', true, true),
        ('Primary scheme', 'letter', 80, 89, 'A', 8::numeric, 'Excellent', true, true),
        ('Primary scheme', 'letter', 75, 79, 'B+', 7::numeric, 'Very good', true, true),
        ('Primary scheme', 'letter', 70, 74, 'B', 6::numeric, 'Good', true, true),
        ('Primary scheme', 'letter', 65, 69, 'C+', 5::numeric, 'Above average', true, true),
        ('Primary scheme', 'letter', 60, 64, 'C', 4::numeric, 'Average', true, true),
        ('Primary scheme', 'letter', 50, 59, 'D', 3::numeric, 'Satisfactory', true, true),
        ('Primary scheme', 'letter', 40, 49, 'E', 2::numeric, 'Needs support', false, true),
        ('Primary scheme', 'letter', 0, 39, 'F', 1::numeric, 'Needs urgent support', false, false),
        ('Primary scheme', 'proficiency', 80, 100, 'Highly Proficient', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'proficiency', 68, 79, 'Proficient', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'proficiency', 54, 67, 'Approaching Proficient', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'proficiency', 40, 53, 'Developing Proficient', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'proficiency', 0, 39, 'Emerging Proficient', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'overall_comment', 70, 100, 'Excellent Performance', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'overall_comment', 55, 69, 'Very Good Performance', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'overall_comment', 35, 54, 'Good Performance', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'overall_comment', 20, 34, 'Pass', NULL::numeric, NULL::text, false, false),
        ('Primary scheme', 'overall_comment', 0, 19, 'Fail', NULL::numeric, NULL::text, false, false),
        ('JHS scheme', 'number', 75, 100, '1', 1::numeric, NULL::text, true, true),
        ('JHS scheme', 'number', 70, 74, '2', 2::numeric, NULL::text, true, true),
        ('JHS scheme', 'number', 65, 69, '3', 3::numeric, NULL::text, true, true),
        ('JHS scheme', 'number', 60, 64, '4', 4::numeric, NULL::text, true, true),
        ('JHS scheme', 'number', 55, 59, '5', 5::numeric, NULL::text, true, true),
        ('JHS scheme', 'number', 50, 54, '6', 6::numeric, NULL::text, true, true),
        ('JHS scheme', 'number', 45, 49, '7', 7::numeric, NULL::text, false, true),
        ('JHS scheme', 'number', 40, 44, '8', 8::numeric, NULL::text, false, true),
        ('JHS scheme', 'number', 0, 39, '9', 9::numeric, NULL::text, false, false),
        ('JHS scheme', 'overall_comment', 70, 100, 'Excellent Performance', NULL::numeric, NULL::text, false, false),
        ('JHS scheme', 'overall_comment', 55, 69, 'Very Good Performance', NULL::numeric, NULL::text, false, false),
        ('JHS scheme', 'overall_comment', 35, 54, 'Good Performance', NULL::numeric, NULL::text, false, false),
        ('JHS scheme', 'overall_comment', 20, 34, 'Pass', NULL::numeric, NULL::text, false, false),
        ('JHS scheme', 'overall_comment', 0, 19, 'Fail', NULL::numeric, NULL::text, false, false)
      ) AS bands(scheme_name, scale_kind, minimum, maximum, band_label, band_points, band_descriptor, credit, passed)
    LOOP
      SELECT id INTO current_scheme_id FROM grading_schemes
      WHERE school_id = school.id AND name = item.scheme_name;
      SELECT id INTO current_scale_id FROM grading_scales
      WHERE school_id = school.id AND grading_scales.scheme_id = current_scheme_id
        AND kind = item.scale_kind;
      INSERT INTO grade_bands (
        school_id, scheme_id, scale_id, min_score, max_score, label,
        points, descriptor, is_credit, is_pass
      ) VALUES (
        school.id, current_scheme_id, current_scale_id, item.minimum, item.maximum, item.band_label,
        item.band_points, item.band_descriptor, item.credit, item.passed
      ) ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
