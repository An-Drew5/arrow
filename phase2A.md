# Task: Build Phase 2A (Academic Core) of the Arrow school management SaaS

## Context
Phase 1 is done and on `main`: Express + TypeScript, Kysely, PostgreSQL 16 with forced RLS, tenant-scoped transactions (`tenantContext` middleware), auth with refresh rotation, RBAC (`can()` + `requirePermission`), audit logging, and a real-Postgres isolation suite (16 tests, including a registration -> approval -> login regression test). READ the existing code first and follow its conventions exactly: module layout, Zod validation, error shape `{code,message,details?}`, `recordAudit`, numbered SQL migrations, composite FKs, the RLS policy pattern, test helpers.

The domain rules below come from a real Ghanaian primary school's Excel assessment workbook (Basic 5, 66 pupils, 9 subjects) and from the product owner. Treat them as requirements, not suggestions.

This task is ONLY Phase 2A. Do NOT build: PDF generation, Excel workbook import, report-card PDF layout, broadsheet export files, AI or analytics endpoints, finance, parent/student portals, any UI, SHS/WASSCE specifics, KG, or the offline client. (Phase 2B and later cover those.) Levels in scope: Primary (Basic 1-6) and JHS (JHS 1-3, i.e. Basic 7-9).

## Non-negotiables (carry over from Phase 1)
1. Every new tenant table: `school_id uuid not null`, an index starting with `school_id`, `ENABLE` + `FORCE` RLS with the same `tenant_isolation` policy pattern, composite FKs `(school_id, id)` to other tenant tables.
2. The school comes only from the verified token. Never from URL, query or body.
3. All data access runs inside the request's tenant transaction. State-changing requests and denied permission checks are audited in the same transaction.
4. Access outside the caller's scope returns 404, identical to a non-existent record.
5. New tests create everything through the API. Direct-to-database fixtures are allowed only for tenancy setup (schools, users).
6. Never use binary floating point for marks. Use exact decimal or integer arithmetic (for example scale marks by 10 to hold one decimal place, and use rational/integer math for scaling). Rounding is always half-up, never banker's rounding.

## Domain rules (decided with the school)

### Assessment structure
- SBA (school-based assessment) is made of four components, configurable per scheme. Default: Class exercise 15, Group work 15, Class test 15, Project work 15 (SBA maximum 60). The exam is a fifth component, default maximum 100.
- Teachers never create assessments. When a term opens (and when a subject is added to a class mid-term) the system auto-creates one assessment per class, subject, term and scheme component, idempotently. Changing a scheme's components affects future terms only; a term that already has scores keeps its components.
- Marks may have at most one decimal place and must be between 0 and the component maximum.
- A score has a status: `scored`, `absent` or `excused`. A missing row means "not yet entered".

### Result calculation (default weights SBA 50 / exam 50, both editable per scheme, with optional per-subject and per-level overrides; most specific wins: subject+level, subject, level, scheme default)
1. `sba_raw` = sum of marks of the non-excused SBA components. An `absent` SBA component counts as 0. `sba_max` = sum of maxima of the non-excused SBA components.
2. `sba_scaled` = round_half_up(sba_raw / sba_max * sba_weight).
3. `exam_scaled` = round_half_up(exam_raw / exam_max * exam_weight).
4. `total` = `sba_scaled` + `exam_scaled`. The card always adds up, because the total is the sum of the two rounded numbers. Grades, ranks and aggregates use these whole numbers.
5. Status is `incomplete` (no grade, never treated as zero) if any non-excused SBA component is not entered, if the exam is not entered, or if the exam is `absent`/`excused`. Record the reason. A head can resolve an absent exam by entering a mark.
6. Store the scheme snapshot (components, weights, scales and bands used) on every result so later scheme edits never change past results.

### Scales (a scheme carries several; the school chooses which print)
- Bands cover 0-100 on whole numbers with no gaps or overlaps; validate on write.
- Scale kinds: `letter`, `proficiency`, `number`, `overall_comment`. Metric is `subject_total` or `average`.
- Only the `letter` and `number` scales carry `is_credit` / `is_pass` flags.
- Seed per school (idempotent; also backfill existing schools):
  - **Primary scheme** (levels 1-6), weights 50/50, components as above:
    - letter, higher is better: 90-100 A+ (Outstanding, points 9), 80-89 A (Excellent, 8), 75-79 B+ (Very good, 7), 70-74 B (Good, 6), 65-69 C+ (Above average, 5), 60-64 C (Average, 4), 50-59 D (Satisfactory, 3), 40-49 E (Needs support, 2), 0-39 F (Needs urgent support, 1). `is_credit` for A+ to D (50 and above), `is_pass` for A+ to E (40 and above).
    - proficiency: 80-100 Highly Proficient, 68-79 Proficient, 54-67 Approaching Proficient, 40-53 Developing Proficient, 0-39 Emerging Proficient. These cut-offs are UNVERIFIED (the sample workbook uses 80, 79, 67, 53, which looks mistyped). Put "to be confirmed against the official scale" in each scale's description.
    - overall_comment, metric `average`: 70-100 Excellent Performance, 55-69 Very Good Performance, 35-54 Good Performance, 20-34 Pass, 0-19 Fail (the sample workbook's totals 700/550/350/200 expressed as averages).
  - **JHS scheme** (levels 7-9), weights 50/50 and the same components until a JHS sample is seen (note this in the description):
    - number, `lower_is_better = true`: 75-100 = 1, 70-74 = 2, 65-69 = 3, 60-64 = 4, 55-59 = 5, 50-54 = 6, 45-49 = 7, 40-44 = 8, 0-39 = 9. `is_credit` for 1-6, `is_pass` for 1-8.
    - the same overall_comment scale.
  - All of these are editable defaults and not verified against an official GES document. Say so in their descriptions.
- `school_settings.report_scale_kinds` chooses which subject scales print, per level group. Default: primary `["letter","proficiency"]`, JHS `["number"]`. The school sets it during setup and can change it later in account settings, so it must be editable via the API.

### Position, aggregate and overall comment
- Subject position: competition ranking (1, 2, 2, 4) of the subject total within class + subject + term, over `complete` results only. Higher total is always the better rank, including for `lower_is_better` scales (that only affects the grade label).
- Aggregate: sum of the pupil's best N subject totals (N = `aggregate_subject_count`, default 6; effective N = min(N, number of subjects the pupil takes)). A pupil with fewer than N complete results has no aggregate and no overall position, and is listed as "unrankable".
- Overall position: competition ranking by aggregate (setting `position_basis`: `best_n` default, or `all_subjects` using the sum of all subject totals). Ties share a position and the next is skipped.
- Also per pupil: total raw score, `out_of` (complete subjects x 100), average (mean of complete subject totals, rounded half-up to a whole number), subjects passed / failed (total >= `pass_mark`, default 40, editable), class enrolment (active enrollments in the class), overall comment (average looked up in the overall_comment scale).
- Position labels use ordinals: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 101st, 111th.
- Pupils who do not take a subject (electives): `student_subject_opt_outs` excludes them from that subject's results, ranks, aggregates and readiness checks.

### Daily attendance (non-negotiable for schools)
- Teachers take a register each school day. The register opens with every enrolled pupil preset to `present`; the teacher changes only exceptions (absent, late, excused) and submits. Statuses: present, absent, late, excused. Late counts as present when `late_counts_as_present` is true (default).
- A day counts as OPEN for a class once that class's register is submitted. Term attendance for a pupil = days present out of days open, where days open = submitted registers of the pupil's class dated between max(term start, enrollment start) and min(term end, enrollment end). A pupil who joins mid-term is counted only from the day they joined.
- Not allowed: registers for future dates. Edits after the term is locked need `terms:lock` approval with a reason and are audited.
- `term_attendance` stores days_present, days_open and source `computed` or `imported`. Computed wins when registers exist; otherwise the imported summary is used. Imported totals must satisfy days_present <= days_open.
- `school_closures` (date range, reason) records holidays and closures; they only silence missing-register warnings.

### Who enters marks (teacher assignment types)
- `subject`: teacher for one subject of a class. Writes scores for that class and subject only.
- `class_teacher`: attendance register and read access to all subjects of the class. No score writes.
- `all_subjects`: class teacher who also teaches every subject (usual in Basic 1-3). Class-teacher rights plus score writes for every current and future subject of the class.
- Assignments have a year and optional end date; access ends with the assignment. An assigned teacher may read the academic history (all past results) of pupils currently enrolled in their assigned class, and loses it when the assignment ends.

## Data model (new migrations, numbered after the existing ones)
- `schools`: add address, phone, email, district_directorate, headteacher_name (nullable).
- `school_settings` (one row per school): position_basis, aggregate_subject_count, pass_mark, late_counts_as_present, sba_exam_gap_threshold (default 30), report_scale_kinds (jsonb). Seeded with defaults on registration/approval and backfilled.
- `academic_years` (name, start_date, end_date, status `open|closed`; one open year per school); `terms` (year, name, term_number 1-3, start_date, end_date, vacation_date, next_term_begins, status `open|locked`).
- `classes` (year, name, level 1-9, stream nullable; unique per school+year+name); `subjects` (name, code; unique per school); `class_subjects` (class, subject).
- `students` (admission_no unique per school, first_name, last_name, other_names, date_of_birth, gender, status `active|archived`). `admission_no` is generated when blank (for example `<school slug prefix>-<zero-padded sequence>`), editable later. Never hard-deleted. Encrypt `date_of_birth` at the application level. `guardians` (student, name, relationship, phone encrypted, is_primary).
- `enrollments` (student, class, year, roll_number, start_date, end_date nullable, status; one active enrollment per student per year). `roll_number` is auto-assigned alphabetically by surname within the class and editable; it prints as the serial number on report cards.
- `student_subject_opt_outs` (student, class_subject).
- `teacher_assignments` (teacher membership, class, subject nullable, year, type `subject|class_teacher|all_subjects`, start_date, end_date nullable). CHECK: subject is required for `subject` and null otherwise.
- `grading_schemes` (name, level_from, level_to, sba_weight, exam_weight, exam_max_mark, is_default; CHECK weights sum to 100); `scheme_components` (scheme, name, kind `sba|exam`, max_mark, sort_order); `grading_scales` (scheme, name, kind, metric, lower_is_better, description); `grade_bands` (scale, min_score, max_score, label, points, descriptor, is_credit, is_pass); `grading_scheme_overrides` (scheme, subject nullable, level nullable, sba_weight, exam_weight).
- `assessments` (class, subject, term, scheme_component); `scores` (assessment, student, mark nullable, status, entered_by, version, client_id unique per school); `score_versions` (score, old mark, new mark, old status, new status, changed_by, reason, changed_at).
- `term_results` (student, class, subject, term, sba_raw, sba_max, exam_raw, exam_max, sba_scaled, exam_scaled, total, grades jsonb keyed by scale kind, subject_position, status `complete|incomplete`, incomplete_reason, source `computed|imported`, scheme_snapshot jsonb, computed_at). Unique per student, subject, term.
- `term_summaries` (student, class, term, results_complete, total_raw, out_of, average, aggregate, overall_position, subjects_passed, subjects_failed, class_enrolment, overall_comment, scheme_snapshot jsonb).
- `attendance_registers` (class, date, status `draft|submitted`, taken_by, submitted_at; unique per class+date); `attendance` (register, student, status, client_id unique per school); `school_closures`; `term_attendance`.
- `import_jobs` (kind, status, file reference, summary, error report, created_by).

## Pure computation module (heavily unit-tested)
Implement the calculation, scale lookup, ranking, aggregate and ordinal-label logic as pure functions with no database access. Test vectors (SBA 50 / exam 50 unless stated; letter, proficiency, JHS number shown):
- SBA components 12, 10, 14, 9 (45/60), exam 70/100: SBA 38 (37.5 rounds up), exam 35, total 73, B, Proficient, JHS 2.
- SBA 38/60, exam 34/100: SBA 32, exam 17, total 49, E, Developing Proficient, JHS 7.
- SBA 60/60, exam 33/100: SBA 50, exam 17 (16.5 rounds UP; banker's rounding would give 16 and must fail the test), total 67, C+, Approaching Proficient, JHS 3.
- SBA components 15, 12, excused, 10 (37 of 45), exam 80/100: SBA 41, exam 40, total 81, A, Highly Proficient, JHS 1.
- SBA components 15, absent, 14, 9 (38/60; absent counts as 0), exam 70/100: SBA 32, exam 35, total 67.
- JHS scheme, SBA 48/60, exam 52/100: SBA 40, exam 26, total 66, JHS 3.
- Override weights 40/60, SBA 45/60, exam 70/100: SBA 30, exam 42, total 72.
- Missing exam, or absent exam: `incomplete`, no grade, reason recorded.
- Best 6 of totals [81, 73, 67, 49, 90, 60, 55, 44, 70] = 90 + 81 + 73 + 70 + 67 + 60 = 441. Average of those nine = 65.
- Competition ranking of [441, 441, 400, 380, 380, 300] gives [1, 1, 3, 4, 4, 6].
- Ordinals for 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd, 101st, 111th, 112th.
- Scheme edited after compute: stored results and snapshots unchanged until recomputed.

## Authorization
Add permissions (keep existing ones): `academics:manage`, `students:read`, `students:write`, `scores:read`, `scores:write`, `attendance:read`, `attendance:write`, `grading:manage`, `settings:manage`, `results:compute`, `terms:lock`, `reports:read`, `imports:run`. Default role mappings:
- school_admin: everything. headteacher: read all, `reports:read`, `results:compute`, `terms:lock`. records_officer: students, enrollments, imports, `attendance:read`; no scores. subject_teacher: scores read/write for assigned subject. class_teacher: attendance and read of all subjects in own class.
Fill the Phase 1 scope extension point in `can()` to implement the assignment types above. Out-of-scope returns 404; denials are audited.

## Term lock
`POST /terms/:id/compute-results` computes results, summaries and term attendance for the whole term (idempotent, recomputable until locked). `POST /terms/:id/lock` (headteacher) freezes scores, registers and results. After lock, score or register edits need `terms:lock` approval and a reason, write a `score_versions` row plus an audit entry, and recompute the affected pupil's results with a new snapshot.

## Readiness check
`GET /terms/:id/readiness?classId=` returns, per class: marks still missing by subject and component (with entered and expected counts and the assigned teachers); weekdays in the term so far with no submitted register and no closure; identical marks across subjects (a component whose marks match between two subjects for at least 90% of pupils, minimum 10 pupils); pupils whose SBA percentage and exam percentage differ by at least `sba_exam_gap_threshold` points in a subject; and unrankable pupils. Add `ready` (true when nothing is missing and nobody is unrankable). The identical-marks and gap items are warnings, not blockers. These are plain deterministic rules; no AI.

## Report-card data and broadsheet (JSON only)
- `GET /terms/:id/report-cards?classId=&studentIds=`: for each pupil, return everything a GES-style card prints: school profile (name, address, phone, email, district directorate, headteacher), class name, term name, vacation date, next term begins, roll number (serial number), pupil name, per-subject rows (SBA scaled out of the SBA weight, exam scaled, total, position label, and the grades for the scales selected in `report_scale_kinds`), total raw score and out of, average, aggregate, subjects passed and failed, class enrolment, overall position label, attendance (present of open), overall comment. Requires results to be computed.
- `GET /classes/:id/broadsheet?termId=`: roll number, name, every subject total, total, aggregate, overall position label.

## School settings and profile
`GET/PATCH /school/settings` (`settings:manage`) and `GET/PATCH /school/profile`. Validate ranges (for example aggregate_subject_count 1-12, pass_mark 0-100). Changing settings never rewrites stored results; the change applies at the next compute and is recorded in the snapshot.

## Sync-ready writes (so offline entry can be added later without rewriting the API)
- Every row in score and attendance writes carries a client-generated `clientId` (uuid), unique per school. Replaying a request returns the original result and never applies twice.
- Batch responses are per row: `{ clientId, outcome: "applied" | "conflict" | "rejected", currentMark?, currentVersion?, reason? }`. A conflict means the stored version differs from the supplied expected `version`. A locked term returns `rejected` with `TERM_LOCKED`. One bad row never fails the batch.
- `GET /sync/bootstrap?classId=` returns only what the caller may see for offline use: roster (id, roll number, name only), the open term's assessments and components, existing scores, and the class's recent registers. No dates of birth, guardians or contact details. Out-of-scope classes return 404.
- Accept an optional `enteredAt` per row, stored in audit metadata. Server time stays authoritative.

## Bulk import (CSV; Phase 2B adds the Excel workbook importer)
Three downloadable templates: students (admission_no optional, first_name, last_name, other_names, date_of_birth, gender, class_name, guardian_name, guardian_phone, guardian_relationship); historical results (admission_no, class_name, academic_year, term_number, subject_code, sba_raw, exam_raw); attendance totals (admission_no, academic_year, term_number, days_present, days_open).
- Historical results are stored as `term_results` with `source = 'imported'`; the scaling, rounding, grading and snapshot follow the same rules as computed results, using the class level's scheme. No component rows are needed. Imported rows never overwrite computed rows for the same student, subject and term; report them as skipped with a reason.
- Every import first runs as a dry run (`?dryRun=true`) returning a row-by-row preview of errors without writing. A real run is a BullMQ background job returning a job id; poll `GET /imports/:id`.
- Idempotent: students match on admission_no (or on name + class when it is blank) and update instead of duplicating; results and attendance match on student + year + term (+ subject).
- Limits: 5 MB and 5000 rows per file. Downloadable CSV error report. Audit who ran it.

## Endpoints (under /api/v1; propose any missing ones before adding)
Academic years, terms, classes, subjects, class-subjects, students (search by name or admission_no, scoped), guardians, enrollments (including promote-class and roll-number reorder), opt-outs, teacher-assignments, grading-schemes (+ components, scales, bands, overrides), `PUT /assessments/:id/scores` (batch), attendance registers (`GET /classes/:id/registers/:date` returns the preset-present roster; `PUT` saves and optionally submits), closures, terms compute/lock/readiness, `GET /results` (filter by class, subject, term, student), report-cards, broadsheet, school settings and profile, sync bootstrap, imports.

## Acceptance criteria (the Phase 2A gate)
1. All 16 existing tests still pass, and the isolation suite automatically covers every new tenant table (the table-inspection test must fail if one lacks forced RLS).
2. Cross-school tests on the new tables: school A cannot read or write school B rows via the API or direct queries as the app role.
3. Scope tests: a `subject` teacher cannot read or write scores or registers for an unassigned class or subject (404); a `class_teacher` can take the register and read all subjects but cannot write scores; an `all_subjects` teacher can write every subject of the class but nothing outside it; access ends when the assignment ends.
4. Computation unit tests pass for every vector above, plus override resolution, opt-outs, unrankable pupils, tie ranking, `position_basis` switching and snapshot immutability after a scheme edit.
5. Attendance tests: the register opens preset-present; only submitted registers count as open days; late counts per the setting; a mid-term joiner is counted from their start date; imported totals are used only when no registers exist; future dates are rejected.
6. Term lock tests: edits after lock without approval are denied and audited; with approval they are versioned and recomputed.
7. Import tests: dry run writes nothing; re-running creates no duplicates; bad rows appear in the error report; imported results never overwrite computed ones; blank admission numbers are generated.
8. Sync tests: a replayed batch applies once; a mixed batch returns per-row outcomes; bootstrap respects scope and contains no date of birth or guardian data.
9. One end-to-end API test with NO database shortcuts after tenancy setup: register a school, approve, log in as admin, set school profile and settings, create year, term, class, subjects, students (CSV import), enrollments, an `all_subjects` teacher assignment, take and submit several registers, enter all SBA components and exams for every subject, run the readiness check, compute results, lock the term, then read report-card data and the broadsheet and assert the figures against hand-computed values.
10. Migrations apply on a fresh database and are idempotent on a second run. `npm run typecheck`, `npm run build` and `npm audit` pass.

## How to work
- Before coding, give a plan under 25 lines and list your assumptions. Ask only about decisions that are hard to reverse.
- Small commits in this order: migrations and RLS; scales and seeds; academic structure and students; assignments and `can()` scope; assessments, scores and the computation module; attendance; term compute and lock; readiness; report-card data and broadsheet; settings; sync-ready writes; imports; end-to-end test; README updates.
- Run the full suite against real PostgreSQL after each step and show the results. If Docker or Postgres is unavailable, say so clearly and do NOT report a step as done; do not leave tests skipped.
- Before finishing, run the end-to-end flow manually through the real API, not only through tests. Phase 1's login bug was invisible to fixture-based tests for exactly this reason.
- Do not add features, libraries or abstractions beyond this spec. If something looks missing or contradictory, tell me instead of adding or guessing. Commit formatting-only changes separately.


## Bugs 
Phase 2A fixes on branch phase-2a (PR #1). Independent verification found two blocking bugs and a few small gaps. Fix them in this order and add the tests described.

BUG 1: platform approval returns 401
The academics routers (academicsRoutes, academicCoreRoutes, attendanceRoutes, teacherRoutes, schoolRoutes) each call router.use(tenantContext) and are mounted at "/api/v1" before platformRoutes. So every request to /api/v1/platform/* passes through tenantContext first and a platform admin token is rejected.
- Fix: in src/app.ts, mount platformRoutes directly after tenantRoutes, before any router that applies tenantContext.
- Better: stop router-wide `router.use(tenantContext)` on routers mounted at the shared "/api/v1" prefix. Apply tenantContext per route or mount each router under a prefix, so a future router cannot swallow unrelated paths.
- Test: register a school, log in as the platform admin, POST /platform/schools/:id/approve, expect 200. This must run through the real app with supertest, not a direct function call.

BUG 2: POST /terms/:id/compute-results returns 500
Marks are numeric(8,2), so Postgres returns "15.00" and "12.00". tenths() in src/academics/computation.ts accepts at most one decimal place and throws RangeError.
- Fix: normalise numeric strings before parsing (strip trailing zeros), or change the mark and max_mark columns to numeric(8,1) in a new migration. If you choose the migration, handle existing data. Whichever you choose, keep the one-decimal rule for incoming marks.
- Also log unexpected errors in the error handler. A 500 currently leaves no trace on the server.
- Test: an API-level test that creates a year, term, class, subjects, pupils and scores through the endpoints, calls compute-results, and asserts the stored results. Use these hand-checked values:
  Pupil A: English 12/10/14/9 + exam 70 -> 73 (B); Maths 15/15/15/15 + exam 90 -> 95 (A+); Science 8/9/10/7 + exam 55 -> 56 (D). Aggregate 224, average 75, 1st.
  Pupil B: English 15/12/excused/10 + exam 80 -> 81; Maths 10x4 + 45 -> 56; Science 12x4 + 60 -> 70. Aggregate 207, 2nd.
  Pupil C: English 15/absent/14/9 + exam 70 -> 67; Maths 6x4 + 33 -> 37; Science 5x4 + 40 -> 37. Aggregate 141, 3rd.
  Pupil D with no Science exam: Science has no total or position; no aggregate; no overall position.

SMALL GAPS
3. Add GET /roles returning id, name and permissions for the school, guarded by the users:read (or equivalent) permission. The UI needs role IDs to create users.
4. Add GET /classes/:id/assessments (subject-teacher scoped, same scope rules as bootstrap) so screens need not depend on /sync/bootstrap.
5. Locked-term score writes: the per-row outcome TERM_LOCKED is correct, but when every row is rejected for that reason, return 409 instead of 200.
6. Add an "all subjects" convenience: POST /teacher-assignments with type all_subjects must either require or automatically grant both class_teacher and subject_teacher permissions for scoring. Document which one you chose in the PR.

NOT IN THIS FIX
CSV imports and background jobs stay for the next prompt. Do not start them here.

HOW TO WORK
- One commit per item, with its test.
- Run the full suite against real Postgres; CI must stay green.
- Update the PR description's acceptance table: mark an item done only with a test that proves it. State plainly what is still not done.

## follow up
Phase 2A follow-up: JHS aggregate rule (branch phase-2a, PR #1)

Primary keeps the current rule: aggregate = sum of the best N subjects (N = aggregateSubjectCount, default 6). Do not change Primary behaviour.

JHS (class level 7-9) uses: aggregate = all core subjects + the best (N - number of core subjects) of the remaining subjects. With 4 core subjects and N=6 that is the 4 core plus the best 2 others.

1. Core flag: add is_core boolean (default false) on subjects, via a new migration 007. New schools seed English, Mathematics, Integrated Science / Science and Social Studies as core by matching names case-insensitively; schools can edit the flag per subject through the existing subjects update endpoint. Existing schools: apply the same name match in the migration.
2. Rule applies only to JHS classes. Primary classes ignore the flag.
3. If any core subject for a JHS pupil is incomplete or missing, the pupil has no aggregate and no overall position (same as an incomplete subject today).
4. If a JHS pupil has fewer than N - core "other" subjects, use however many exist. Do not fail.
5. Overall position stays competition ranking on the aggregate, with the lower-is-better JHS number scale handled as it is now.
6. Store which subjects counted toward the aggregate in the result snapshot, so report cards and broadsheets can show them.
7. Tests: pure computation tests with hand-checked vectors (4 core + 2 others chosen correctly; a pupil whose best 6 would differ without the core rule; a missing core subject; fewer than 2 other subjects; a Primary pupil unchanged), plus one API-level test through compute-results on a JHS class.

One commit per item, full suite green on real Postgres, and update the PR description honestly.