# Task: Build Phase 2 (Academic Core) of the Arrow school management SaaS

## Context
Phase 1 is done and on `main`: Express + TypeScript, Kysely, PostgreSQL 16 with forced RLS, tenant-scoped transactions (`tenantContext` middleware), auth with refresh rotation, RBAC (`can()` + `requirePermission`), audit logging, and a real-Postgres isolation suite (16 tests). READ the existing code first and follow its conventions exactly (module layout, Zod validation, error shape `{code,message,details?}`, `recordAudit`, numbered SQL migrations, composite FKs, RLS policy pattern, test helpers).

This task is ONLY Phase 2. Do not build AI, analytics endpoints, finance, parent/student portals, report-card PDFs, SHS/WASSCE specifics, KG, or offline sync. Levels in scope: Primary (Basic 1-6) and JHS (JHS 1-3, i.e. Basic 7-9).

## Non-negotiables (carry over from Phase 1)
1. Every new tenant table: `school_id uuid not null`, index starting with `school_id`, `ENABLE` + `FORCE` RLS with the same `tenant_isolation` policy pattern, composite FKs `(school_id, id)` to other tenant tables.
2. The school comes only from the verified token. Never from URL, query or body.
3. All data access inside the request's tenant transaction. State-changing requests and denied permission checks are audited in the same transaction.
4. Access outside the caller's scope returns 404, identical to a non-existent record.
5. No direct-to-database shortcuts in new tests except for tenancy fixtures (schools, users). Create everything else through the API.

## Data model (new migrations, numbered after the existing ones)
- `academic_years` (name, start_date, end_date, status `open|closed`; one open year per school)
- `terms` (academic_year, name, term_number 1-3, start_date, end_date, status `open|locked`)
- `classes` (academic_year, name, level 1-9, stream nullable; unique per school+year+name)
- `subjects` (name, code; unique per school) and `class_subjects` (class, subject)
- `students` (admission_no unique per school, first_name, last_name, other_names, date_of_birth, gender, status `active|archived`). Never hard-deleted. Encrypt `date_of_birth` at the application level.
- `guardians` (student, name, relationship, phone encrypted, is_primary)
- `enrollments` (student, class, academic_year, status; one active enrollment per student per year)
- `teacher_assignments` (membership/teacher, class, subject nullable, academic_year, start_date, end_date nullable). A null subject means class teacher for that class.
- `grading_schemes` (name, level_from, level_to, scale_type `percentage_bands|descriptors`, lower_is_better bool, class_score_weight, exam_weight, is_default; CHECK weights sum to 100)
- `grading_scheme_overrides` (scheme, subject nullable, level nullable, class_score_weight, exam_weight) - optional override of weights per subject and/or level. Most specific match wins: subject+level, then subject, then level, then scheme default.
- `grade_bands` (scheme, min_score, max_score, label, points, descriptor, is_credit, is_pass). Validate on write: bands cover 0-100 on whole numbers with no gaps or overlaps.
- `assessments` (class, subject, term, name, kind `class_test|assignment|project|exam`, max_mark, component `class_score|exam`). Exactly one `exam` component assessment per class+subject+term; any number of `class_score` ones.
- `scores` (assessment, student, mark nullable, status `scored|absent|excused`, entered_by, version). Every change writes a row to `score_versions` (old mark, new mark, changed_by, reason, changed_at). Marks must be between 0 and max_mark.
- `term_results` (student, class, subject, term, class_score_pct, exam_score_pct, total, grade_label, grade_points, subject_rank, status `complete|incomplete`, source `computed|imported`, scheme_snapshot jsonb with weights and bands used, computed_at)
- `attendance` (student, class, date, status `present|absent|late|excused`; unique student+date)
- `import_jobs` (kind, status, file reference, summary, error report, created_by)

Seed per new school (inside school registration/approval, idempotently) two default grading schemes with editable bands:
- "JHS nine-point" (levels 7-9): 1-9 grades, `lower_is_better = true`, weights 30/70. Bands: 75-100=1, 70-74=2, 65-69=3, 60-64=4, 55-59=5, 50-54=6, 45-49=7, 40-44=8, 0-39=9. `is_credit` for 1-6, `is_pass` for 1-8. Label them clearly as editable defaults; they are not verified against an official GES document.
- "Primary descriptors" (levels 1-6): - "Primary A-F" (levels 1-6): `scale_type = percentage_bands`, `lower_is_better = false`, weights 30/70. Bands (whole-number scores, no gaps or overlaps): 90-100=A+ (Outstanding, points 7), 80-89=A (Excellent, 6), 70-79=B (Very good, 5), 60-69=C (Good, 4), 50-59=D (Satisfactory, 3), 40-49=E (Needs support, 2), 0-39=F (Needs urgent support, 1). `is_credit` for A+ through D (score 50 and above), `is_pass` for A+ through E (score 40 and above), the same credit and pass lines as the JHS scheme. These are editable defaults, not verified against an official GES document.

## Result computation (pure, unit-tested function)
For one student, subject, term:
1. class_score_pct = sum(marks of scored `class_score` assessments) / sum(max_marks of those assessments) * 100. Absent or excused assessments are excluded from both sums.
2. exam_score_pct = exam mark / exam max_mark * 100.
3. total = class_score_pct * class_weight/100 + exam_score_pct * exam_weight/100, using the weights resolved by the override rules.
4. Round total half-up to a whole number for band lookup. Store the total with one decimal.
5. If the exam is missing/absent or there are no class-score marks, status is `incomplete`, no grade, never treated as zero.
6. Rank within class+subject using competition ranking (1,2,2,4), only among `complete` results, and respect `lower_is_better` only for grade labels, not for rank (higher total is always the better rank).
7. Store the scheme_snapshot so later scheme edits never change stored results.

Required test vector: class marks 20/25 and 30/40 give 45/65 = 69.2%; wait, use this clean one instead: class_score_pct = 80, exam_score_pct = 60, weights 30/70 gives total 66, which is band 3 on the JHS scale. Add several more vectors including override weights, an absent exam, and a tie in ranking.

## Authorization
Add permissions (keep existing ones): `academics:manage`, `students:read`, `students:write`, `scores:read`, `scores:write`, `attendance:write`, `grading:manage`, `results:compute`, `terms:lock`, `imports:run`. Update default role mappings from the design:
- school_admin: everything above. headteacher: read all, `terms:lock`, `results:compute`. records_officer: students, enrollments, imports; no scores. subject_teacher: scores read/write. class_teacher: attendance, read all subjects in own class.
Fill the Phase 1 scope extension point in `can()`:
- A teacher may read/write scores only for classes+subjects they are assigned to (active assignment dates and the current year).
- A class teacher (assignment with null subject) may read all subjects' scores and write attendance for their class only.
- An assigned teacher may read the academic history (all past term_results) of students currently enrolled in their assigned classes, and loses it when the assignment ends.
- Out-of-scope returns 404; denials are audited.

## Term lock
`POST /terms/:id/compute-results` computes results for the whole term. `POST /terms/:id/lock` (headteacher) freezes scores and results. After lock, score edits need a `reason` and the `terms:lock` permission (headteacher approval), and write a `score_versions` row plus an audit entry; results for the affected student/subject are recomputed with a new snapshot.

## Bulk import
- Two CSV templates (downloadable): students (admission_no, first_name, last_name, other_names, date_of_birth, gender, class_name, guardian_name, guardian_phone, guardian_relationship) and historical results (admission_no, academic_year, term_number, subject_code, class_score_pct, exam_score_pct).
- Historical results are stored directly as `term_results` with `source = 'imported'`, grade looked up from the scheme, no individual assessments required. Imported rows never overwrite computed rows for the same student+subject+term; report them as skipped with a reason.
- Every import runs as a dry run first via `?dryRun=true`, returning a row-by-row preview of errors without writing. A real run is a BullMQ background job returning a job id; poll `GET /imports/:id`.
- Idempotent: students match on admission_no (update, not duplicate); historical results match on student+year+term+subject.
- Limits: 5 MB and 5000 rows per file. Downloadable CSV error report. Audit who ran it.

## Endpoints (under /api/v1; propose any missing ones before adding)
Academic years, terms, classes, subjects, class-subjects, students (search by name or admission_no, scoped), guardians, enrollments (including promote-class), teacher-assignments, grading-schemes (+ bands, overrides), assessments, `PUT /assessments/:id/scores` (batch; each row carries `studentId`, `mark`, `status`, and an expected `version` for optimistic concurrency, so offline sync can be added later), terms compute/lock, `GET /results` (filter by class, subject, term, student), attendance, imports.

## sync-ready score and attendance writes
- Every row in `PUT /assessments/:id/scores` and in attendance writes carries a client-generated `clientId` (uuid). Store it in a unique-per-school column so a replayed request returns the original result and never applies twice.
- The batch response is per row: `{ clientId, outcome: "applied" | "conflict" | "rejected", currentMark?, currentVersion?, reason? }`. A conflict means the stored version differs from the supplied expected `version`. A locked term returns `rejected` with `TERM_LOCKED`. One bad row must not fail the whole batch.
- Add `GET /sync/bootstrap?classId=` returning only what the caller may see for offline use: roster (id, admission_no, name only), the class's assessments for the open term, and existing scores. No dates of birth, guardians or contact details. Out-of-scope classes return 404.
- Accept an optional `enteredAt` timestamp per row, stored in audit metadata. Server time stays authoritative.
- Tests: replayed batch applies once; a mixed batch returns per-row outcomes; bootstrap respects teacher scope.

## Acceptance criteria (the Phase 2 gate)
1. All 16 existing tests still pass, and the isolation suite automatically covers every new tenant table (the table-inspection test must fail if one lacks forced RLS).
2. Cross-school tests on the new tables: school A cannot read or write school B rows via API or direct queries as the app role.
3. Scope tests: a subject teacher cannot read or write scores for an unassigned class or subject (404); a class teacher can read all subjects in their class but not another class; a teacher loses history access when their assignment ends.
4. Result computation unit tests pass, including all vectors above, override resolution, incomplete results, rank ties, and snapshot immutability after a scheme edit.
5. Term lock tests: edit after lock without permission is denied and audited; with approval it is versioned and recomputed.
6. Import tests: dry run writes nothing; re-running an import creates no duplicates; bad rows appear in the error report.
7. One end-to-end API test with NO database shortcuts after tenancy setup: register school, approve, log in as admin, create year, term, class, subject, students, enrollments, assign a teacher, create assessments, enter scores as that teacher, compute results, lock the term, read results.
8. Migrations apply on a fresh database and are idempotent on a second run. `npm run typecheck`, `npm run build` and `npm audit` pass.

## How to work
- Before coding, give a plan under 25 lines and list assumptions. Ask only about decisions that are hard to reverse.
- Small commits in this order: migrations and RLS; grading schemes and seeds; academic structure and students; teacher assignments and `can()` scope; assessments and scores; computation; term lock; attendance; bulk import; end-to-end test; README updates.
- Run the full test suite against real PostgreSQL after each step and show the results. If Docker or Postgres is unavailable, say so clearly and do NOT report a step as done; do not leave tests skipped.
- Before finishing, run the end-to-end flow manually through the real API, not only through tests.
- Do not add features, libraries or abstractions beyond this spec. If something looks missing, tell me instead of adding it. Commit formatting-only changes separately.