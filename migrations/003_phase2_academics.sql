CREATE TABLE academic_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name),
  CHECK (start_date <= end_date)
);
CREATE UNIQUE INDEX academic_years_one_open_per_school_idx
  ON academic_years (school_id) WHERE status = 'open';
CREATE INDEX academic_years_school_status_idx ON academic_years (school_id, status);

CREATE TABLE terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  academic_year_id uuid NOT NULL,
  name text NOT NULL,
  term_number smallint NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, academic_year_id, id),
  UNIQUE (school_id, academic_year_id, term_number),
  FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id),
  CHECK (start_date <= end_date)
);
CREATE INDEX terms_school_year_idx ON terms (school_id, academic_year_id, term_number);

CREATE TABLE classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  academic_year_id uuid NOT NULL,
  name text NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 9),
  stream text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, academic_year_id, id),
  UNIQUE (school_id, academic_year_id, name),
  FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id)
);
CREATE INDEX classes_school_year_level_idx ON classes (school_id, academic_year_id, level);

CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  name text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, code),
  UNIQUE (school_id, name)
);
CREATE INDEX subjects_school_name_idx ON subjects (school_id, name);

CREATE TABLE class_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, class_id, subject_id),
  FOREIGN KEY (school_id, class_id) REFERENCES classes (school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id) ON DELETE CASCADE
);
CREATE INDEX class_subjects_school_class_idx ON class_subjects (school_id, class_id);

CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  admission_no text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  other_names text,
  date_of_birth text,
  gender text NOT NULL CHECK (gender IN ('female', 'male', 'other', 'unspecified')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, admission_no)
);
CREATE INDEX students_school_name_idx ON students (school_id, last_name, first_name);

CREATE TABLE guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  student_id uuid NOT NULL,
  name text NOT NULL,
  relationship text NOT NULL,
  phone text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id) ON DELETE CASCADE
);
CREATE INDEX guardians_school_student_idx ON guardians (school_id, student_id);

CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, academic_year_id, class_id)
    REFERENCES classes (school_id, academic_year_id, id),
  FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years (school_id, id)
);
CREATE UNIQUE INDEX enrollments_one_active_per_student_year_idx
  ON enrollments (school_id, student_id, academic_year_id) WHERE status = 'active';
CREATE INDEX enrollments_school_class_status_idx ON enrollments (school_id, class_id, status);

CREATE TABLE teacher_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  membership_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid,
  academic_year_id uuid NOT NULL,
  start_date date NOT NULL,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, membership_id) REFERENCES memberships (school_id, id),
  FOREIGN KEY (school_id, academic_year_id, class_id)
    REFERENCES classes (school_id, academic_year_id, id),
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
  CHECK (end_date IS NULL OR start_date <= end_date)
);
CREATE INDEX teacher_assignments_school_member_dates_idx
  ON teacher_assignments (school_id, membership_id, start_date, end_date);
CREATE INDEX teacher_assignments_school_class_subject_idx
  ON teacher_assignments (school_id, class_id, subject_id);

CREATE TABLE grading_schemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  name text NOT NULL,
  level_from smallint NOT NULL CHECK (level_from BETWEEN 1 AND 9),
  level_to smallint NOT NULL CHECK (level_to BETWEEN 1 AND 9),
  scale_type text NOT NULL CHECK (scale_type IN ('percentage_bands', 'descriptors')),
  lower_is_better boolean NOT NULL DEFAULT false,
  class_score_weight numeric(5,2) NOT NULL,
  exam_weight numeric(5,2) NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name),
  CHECK (level_from <= level_to),
  CHECK (class_score_weight >= 0 AND exam_weight >= 0),
  CHECK (class_score_weight + exam_weight = 100)
);
CREATE INDEX grading_schemes_school_levels_idx ON grading_schemes (school_id, level_from, level_to);

CREATE TABLE grading_scheme_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  scheme_id uuid NOT NULL,
  subject_id uuid,
  level smallint CHECK (level BETWEEN 1 AND 9),
  class_score_weight numeric(5,2) NOT NULL,
  exam_weight numeric(5,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (school_id, scheme_id, subject_id, level),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, scheme_id) REFERENCES grading_schemes (school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
  CHECK (subject_id IS NOT NULL OR level IS NOT NULL),
  CHECK (class_score_weight >= 0 AND exam_weight >= 0),
  CHECK (class_score_weight + exam_weight = 100)
);
CREATE INDEX grading_overrides_school_scheme_idx ON grading_scheme_overrides (school_id, scheme_id);

CREATE TABLE grade_bands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  scheme_id uuid NOT NULL,
  min_score smallint NOT NULL CHECK (min_score BETWEEN 0 AND 100),
  max_score smallint NOT NULL CHECK (max_score BETWEEN 0 AND 100),
  label text NOT NULL,
  points numeric(5,2),
  descriptor text,
  is_credit boolean NOT NULL DEFAULT false,
  is_pass boolean NOT NULL DEFAULT false,
  UNIQUE (school_id, id),
  UNIQUE (school_id, scheme_id, label),
  FOREIGN KEY (school_id, scheme_id) REFERENCES grading_schemes (school_id, id) ON DELETE CASCADE,
  CHECK (min_score <= max_score)
);
CREATE INDEX grade_bands_school_scheme_score_idx ON grade_bands (school_id, scheme_id, min_score, max_score);

CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  academic_year_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  term_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('class_test', 'assignment', 'project', 'exam')),
  max_mark numeric(8,2) NOT NULL CHECK (max_mark > 0),
  component text NOT NULL CHECK (component IN ('class_score', 'exam')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, academic_year_id, class_id)
    REFERENCES classes (school_id, academic_year_id, id),
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
  FOREIGN KEY (school_id, academic_year_id, term_id)
    REFERENCES terms (school_id, academic_year_id, id),
  FOREIGN KEY (school_id, class_id, subject_id)
    REFERENCES class_subjects (school_id, class_id, subject_id),
  CHECK ((kind = 'exam') = (component = 'exam'))
);
CREATE UNIQUE INDEX assessments_one_exam_component_idx
  ON assessments (school_id, class_id, subject_id, term_id)
  WHERE component = 'exam' AND kind = 'exam';
CREATE INDEX assessments_school_term_class_idx ON assessments (school_id, term_id, class_id);

CREATE TABLE scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  assessment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  mark numeric(8,2),
  status text NOT NULL CHECK (status IN ('scored', 'absent', 'excused')),
  entered_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  client_id uuid NOT NULL,
  entered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, assessment_id, student_id),
  UNIQUE (school_id, client_id),
  FOREIGN KEY (school_id, assessment_id) REFERENCES assessments (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, entered_by) REFERENCES memberships (school_id, id),
  CHECK ((status = 'scored' AND mark IS NOT NULL) OR (status <> 'scored' AND mark IS NULL))
);
CREATE INDEX scores_school_assessment_student_idx ON scores (school_id, assessment_id, student_id);
CREATE INDEX scores_school_student_idx ON scores (school_id, student_id);

CREATE TABLE score_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  score_id uuid NOT NULL,
  old_mark numeric(8,2),
  new_mark numeric(8,2),
  changed_by uuid NOT NULL,
  reason text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, score_id) REFERENCES scores (school_id, id),
  FOREIGN KEY (school_id, changed_by) REFERENCES memberships (school_id, id)
);
CREATE INDEX score_versions_school_score_changed_idx ON score_versions (school_id, score_id, changed_at DESC);

CREATE TABLE term_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  academic_year_id uuid NOT NULL,
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  term_id uuid NOT NULL,
  class_score_pct numeric(5,1),
  exam_score_pct numeric(5,1),
  total numeric(5,1),
  grade_label text,
  grade_points numeric(5,2),
  subject_rank integer,
  status text NOT NULL CHECK (status IN ('complete', 'incomplete')),
  source text NOT NULL CHECK (source IN ('computed', 'imported')),
  scheme_snapshot jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_id, subject_id, term_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, academic_year_id, class_id)
    REFERENCES classes (school_id, academic_year_id, id),
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects (school_id, id),
  FOREIGN KEY (school_id, academic_year_id, term_id)
    REFERENCES terms (school_id, academic_year_id, id)
);
CREATE INDEX term_results_school_class_subject_term_idx
  ON term_results (school_id, class_id, subject_id, term_id, status, total DESC);
CREATE INDEX term_results_school_student_term_idx ON term_results (school_id, student_id, term_id);

CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  attendance_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
  entered_by uuid NOT NULL,
  client_id uuid NOT NULL,
  entered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, student_id, attendance_date),
  UNIQUE (school_id, client_id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES classes (school_id, id),
  FOREIGN KEY (school_id, entered_by) REFERENCES memberships (school_id, id)
);
CREATE INDEX attendance_school_class_date_idx ON attendance (school_id, class_id, attendance_date);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  kind text NOT NULL CHECK (kind IN ('students', 'historical_results')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  file_reference text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_report text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, created_by) REFERENCES memberships (school_id, id)
);
CREATE INDEX import_jobs_school_created_idx ON import_jobs (school_id, created_at DESC);

DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'academic_years', 'terms', 'classes', 'subjects', 'class_subjects',
    'students', 'guardians', 'enrollments', 'teacher_assignments',
    'grading_schemes', 'grading_scheme_overrides', 'grade_bands',
    'assessments', 'scores', 'score_versions', 'term_results', 'attendance', 'import_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid) WITH CHECK (school_id = NULLIF(current_setting(''app.school_id'', true), '''')::uuid)',
      tenant_table
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  academic_years, terms, classes, subjects, class_subjects, students, guardians,
  enrollments, teacher_assignments, grading_schemes, grading_scheme_overrides,
  grade_bands, assessments, scores, score_versions, term_results, attendance, import_jobs
TO arrow_app;
REVOKE DELETE ON students FROM arrow_app;
REVOKE UPDATE, DELETE ON score_versions FROM arrow_app;