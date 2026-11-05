import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { decryptPii, encryptPii } from "../shared/crypto/pii";
import { HttpError } from "../shared/errors/http-error";
import { asyncHandler } from "../shared/middleware/async-handler";
import { requirePermission } from "../shared/middleware/require-permission";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";
import type { Permission } from "../shared/rbac/permissions";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idSchema = z.string().uuid();
const yearSchema = z.object({
  name: z.string().trim().min(2).max(80),
  startDate: dateSchema,
  endDate: dateSchema,
  status: z.enum(["open", "closed"]).default("open"),
}).strict();
const termSchema = z.object({
  name: z.string().trim().min(2).max(80),
  termNumber: z.number().int().min(1).max(3),
  startDate: dateSchema,
  endDate: dateSchema,
}).strict();
const classSchema = z.object({
  academicYearId: idSchema,
  name: z.string().trim().min(1).max(80),
  level: z.number().int().min(1).max(9),
  stream: z.string().trim().max(40).nullable().optional(),
}).strict();
const subjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(20).toUpperCase(),
}).strict();
const studentSchema = z.object({
  admissionNo: z.string().trim().min(1).max(40),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  otherNames: z.string().trim().max(200).nullable().optional(),
  dateOfBirth: dateSchema.nullable().optional(),
  gender: z.enum(["female", "male", "other", "unspecified"]),
}).strict();
const guardianSchema = z.object({
  name: z.string().trim().min(1).max(160),
  relationship: z.string().trim().min(1).max(60),
  phone: z.string().trim().min(7).max(40),
  isPrimary: z.boolean().default(false),
}).strict();
const enrollmentSchema = z.object({
  academicYearId: idSchema,
  classId: idSchema,
}).strict();
const promoteSchema = z.object({
  studentIds: z.array(idSchema).min(1).max(500),
  academicYearId: idSchema,
  classId: idSchema,
}).strict();
const schemeSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500),
  levelFrom: z.number().int().min(1).max(9),
  levelTo: z.number().int().min(1).max(9),
  scaleType: z.enum(["percentage_bands", "descriptors"]),
  lowerIsBetter: z.boolean().default(false),
  classScoreWeight: z.number().min(0).max(100),
  examWeight: z.number().min(0).max(100),
  isDefault: z.boolean().default(false),
}).strict().refine((value) => value.levelFrom <= value.levelTo, {
  message: "levelFrom must not exceed levelTo",
  path: ["levelTo"],
}).refine((value) => value.classScoreWeight + value.examWeight === 100, {
  message: "Assessment weights must total 100",
  path: ["examWeight"],
});
const schemeUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  levelFrom: z.number().int().min(1).max(9).optional(),
  levelTo: z.number().int().min(1).max(9).optional(),
  scaleType: z.enum(["percentage_bands", "descriptors"]).optional(),
  lowerIsBetter: z.boolean().optional(),
  classScoreWeight: z.number().min(0).max(100).optional(),
  examWeight: z.number().min(0).max(100).optional(),
  isDefault: z.boolean().optional(),
}).strict();
const bandSchema = z.object({
  minScore: z.number().int().min(0).max(100),
  maxScore: z.number().int().min(0).max(100),
  label: z.string().trim().min(1).max(30),
  points: z.number().min(0).max(100).nullable().optional(),
  descriptor: z.string().trim().max(200).nullable().optional(),
  isCredit: z.boolean().default(false),
  isPass: z.boolean().default(false),
}).strict();
const overrideSchema = z.object({
  subjectId: idSchema.nullable().optional(),
  level: z.number().int().min(1).max(9).nullable().optional(),
  classScoreWeight: z.number().min(0).max(100),
  examWeight: z.number().min(0).max(100),
}).strict().refine((value) => value.subjectId != null || value.level != null, {
  message: "An override must specify a subject, level, or both",
}).refine((value) => value.classScoreWeight + value.examWeight === 100, {
  message: "Assessment weights must total 100",
});

export const academicsRoutes = Router();
academicsRoutes.use(tenantContext);

function context(request: RequestWithTenant) {
  return request.tenantContext;
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
  }
  return parsed.data;
}

function parseId(value: string | undefined): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
  }
  return parsed.data;
}

function actor(request: RequestWithTenant) {
  const { claims } = context(request);
  return { schoolId: claims.schoolId!, userId: claims.userId };
}

function route(permission: Permission, handler: (request: RequestWithTenant, response: import("express").Response) => Promise<void>) {
  return [requirePermission(permission), asyncHandler((request, response) => handler(request as RequestWithTenant, response))] as const;
}

academicsRoutes.get("/academic-years", ...route("students:read", async (request, response) => {
  const { tx } = context(request);
  const rows = await sql`
    SELECT id, name, start_date AS "startDate", end_date AS "endDate", status
    FROM academic_years WHERE school_id = ${actor(request).schoolId}::uuid
    ORDER BY start_date DESC
  `.execute(tx);
  response.json({ items: rows.rows });
}));

academicsRoutes.post("/academic-years", ...route("academics:manage", async (request, response) => {
  const input = parseBody(yearSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO academic_years (school_id, name, start_date, end_date, status)
    VALUES (${schoolId}::uuid, ${input.name}, ${input.startDate}, ${input.endDate}, ${input.status})
    RETURNING id
  `.execute(tx);
  const id = result.rows[0]!.id;
  await recordAudit(tx, { schoolId, userId, action: "academic_year.created", resourceType: "academic_year", resourceId: id });
  response.status(201).json({ id, ...input });
}));

academicsRoutes.get("/academic-years/:id/terms", ...route("students:read", async (request, response) => {
  const id = parseId(request.params.id);
  const { tx } = context(request);
  const year = await sql`SELECT id FROM academic_years WHERE id = ${id}::uuid`.execute(tx);
  if (!year.rows[0]) throw new HttpError(404, "NOT_FOUND", "Academic year not found");
  const terms = await sql`
    SELECT id, name, term_number AS "termNumber", start_date AS "startDate",
      end_date AS "endDate", status
    FROM terms WHERE academic_year_id = ${id}::uuid ORDER BY term_number
  `.execute(tx);
  response.json({ items: terms.rows });
}));

academicsRoutes.post("/academic-years/:id/terms", ...route("academics:manage", async (request, response) => {
  const yearId = parseId(request.params.id);
  const input = parseBody(termSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO terms (school_id, academic_year_id, name, term_number, start_date, end_date)
    SELECT school_id, id, ${input.name}, ${input.termNumber}, ${input.startDate}, ${input.endDate}
    FROM academic_years WHERE id = ${yearId}::uuid
    RETURNING id
  `.execute(tx);
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Academic year not found");
  await recordAudit(tx, { schoolId, userId, action: "term.created", resourceType: "term", resourceId: result.rows[0].id });
  response.status(201).json({ id: result.rows[0].id, academicYearId: yearId, ...input, status: "open" });
}));

academicsRoutes.get("/terms/:id", ...route("students:read", async (request, response) => {
  const id = parseId(request.params.id);
  const { tx } = context(request);
  const result = await sql`
    SELECT id, academic_year_id AS "academicYearId", name,
      term_number AS "termNumber", start_date AS "startDate", end_date AS "endDate", status
    FROM terms WHERE id = ${id}::uuid
  `.execute(tx);
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Term not found");
  response.json(result.rows[0]);
}));

academicsRoutes.post("/classes", ...route("academics:manage", async (request, response) => {
  const input = parseBody(classSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO classes (school_id, academic_year_id, name, level, stream)
    SELECT school_id, id, ${input.name}, ${input.level}, ${input.stream ?? null}
    FROM academic_years WHERE id = ${input.academicYearId}::uuid
    RETURNING id
  `.execute(tx);
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Academic year not found");
  const id = result.rows[0].id;
  await recordAudit(tx, { schoolId, userId, action: "class.created", resourceType: "class", resourceId: id });
  response.status(201).json({ id, ...input });
}));

academicsRoutes.get("/classes", ...route("students:read", async (request, response) => {
  const yearId = request.query.academicYearId ? parseId(String(request.query.academicYearId)) : undefined;
  const { tx } = context(request);
  const rows = yearId
    ? await sql`SELECT id, academic_year_id AS "academicYearId", name, level, stream FROM classes WHERE academic_year_id = ${yearId}::uuid ORDER BY level, name`.execute(tx)
    : await sql`SELECT id, academic_year_id AS "academicYearId", name, level, stream FROM classes ORDER BY level, name`.execute(tx);
  response.json({ items: rows.rows });
}));

academicsRoutes.post("/subjects", ...route("academics:manage", async (request, response) => {
  const input = parseBody(subjectSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO subjects (school_id, name, code) VALUES (${schoolId}::uuid, ${input.name}, ${input.code})
    RETURNING id
  `.execute(tx);
  const id = result.rows[0]!.id;
  await recordAudit(tx, { schoolId, userId, action: "subject.created", resourceType: "subject", resourceId: id });
  response.status(201).json({ id, ...input });
}));

academicsRoutes.get("/subjects", ...route("students:read", async (request, response) => {
  const { tx } = context(request);
  const rows = await sql`SELECT id, name, code FROM subjects ORDER BY name`.execute(tx);
  response.json({ items: rows.rows });
}));

academicsRoutes.get("/classes/:id/subjects", ...route("students:read", async (request, response) => {
  const classId = parseId(request.params.id);
  const { tx } = context(request);
  const classroom = await sql`SELECT id FROM classes WHERE id = ${classId}::uuid`.execute(tx);
  if (!classroom.rows[0]) throw new HttpError(404, "NOT_FOUND", "Class not found");
  const rows = await sql`
    SELECT cs.id, s.id AS "subjectId", s.name, s.code
    FROM class_subjects cs JOIN subjects s
      ON s.school_id = cs.school_id AND s.id = cs.subject_id
    WHERE cs.class_id = ${classId}::uuid ORDER BY s.name
  `.execute(tx);
  response.json({ items: rows.rows });
}));

academicsRoutes.post("/classes/:id/subjects", ...route("academics:manage", async (request, response) => {
  const classId = parseId(request.params.id);
  const input = z.object({ subjectId: idSchema }).strict().parse(request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO class_subjects (school_id, class_id, subject_id)
    SELECT ${schoolId}::uuid, c.id, s.id FROM classes c CROSS JOIN subjects s
    WHERE c.id = ${classId}::uuid AND s.id = ${input.subjectId}::uuid
    ON CONFLICT (school_id, class_id, subject_id) DO NOTHING
    RETURNING id
  `.execute(tx);
  if (!result.rows[0]) {
    const exists = await sql<{ id: string }>`SELECT id FROM class_subjects WHERE class_id = ${classId}::uuid AND subject_id = ${input.subjectId}::uuid`.execute(tx);
    if (!exists.rows[0]) throw new HttpError(404, "NOT_FOUND", "Class or subject not found");
    response.status(200).json({ id: exists.rows[0].id });
    return;
  }
  await recordAudit(tx, { schoolId, userId, action: "class_subject.created", resourceType: "class_subject", resourceId: result.rows[0].id });
  response.status(201).json({ id: result.rows[0].id });
}));

academicsRoutes.post("/students", ...route("students:write", async (request, response) => {
  const input = parseBody(studentSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO students (school_id, admission_no, first_name, last_name, other_names, date_of_birth, gender)
    VALUES (
      ${schoolId}::uuid, ${input.admissionNo}, ${input.firstName}, ${input.lastName},
      ${input.otherNames ?? null}, ${input.dateOfBirth ? encryptPii(input.dateOfBirth) : null}, ${input.gender}
    ) RETURNING id
  `.execute(tx);
  const id = result.rows[0]!.id;
  await recordAudit(tx, { schoolId, userId, action: "student.created", resourceType: "student", resourceId: id });
  response.status(201).json({ id, ...input });
}));

academicsRoutes.get("/students", ...route("students:read", async (request, response) => {
  const query = z.object({ q: z.string().trim().max(120).optional(), classId: idSchema.optional() }).safeParse(request.query);
  if (!query.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", query.error.issues);
  const { tx } = context(request);
  if (query.data.classId) {
    const classExists = await sql`SELECT id FROM classes WHERE id = ${query.data.classId}::uuid`.execute(tx);
    if (!classExists.rows[0]) throw new HttpError(404, "NOT_FOUND", "Class not found");
  }
  const rows = await sql`
    SELECT DISTINCT st.id, st.admission_no AS "admissionNo", st.first_name AS "firstName",
      st.last_name AS "lastName", st.other_names AS "otherNames", st.gender, st.status
    FROM students st
    LEFT JOIN enrollments e ON e.school_id = st.school_id AND e.student_id = st.id AND e.status = 'active'
    WHERE (${query.data.q ?? null}::text IS NULL OR
      st.admission_no ILIKE '%' || ${query.data.q ?? ""} || '%' OR
      st.first_name ILIKE '%' || ${query.data.q ?? ""} || '%' OR
      st.last_name ILIKE '%' || ${query.data.q ?? ""} || '%')
      AND (${query.data.classId ?? null}::uuid IS NULL OR e.class_id = ${query.data.classId ?? null}::uuid)
    ORDER BY st.last_name, st.first_name LIMIT 200
  `.execute(tx);
  response.json({ items: rows.rows });
}));

academicsRoutes.get("/students/:id", ...route("students:read", async (request, response) => {
  const id = parseId(request.params.id);
  const { tx } = context(request);
  const result = await sql<{
    id: string; admission_no: string; first_name: string; last_name: string;
    other_names: string | null; date_of_birth: string | null; gender: string; status: string;
  }>`
    SELECT id, admission_no, first_name, last_name, other_names, date_of_birth, gender, status
    FROM students WHERE id = ${id}::uuid
  `.execute(tx);
  const student = result.rows[0];
  if (!student) throw new HttpError(404, "NOT_FOUND", "Student not found");
  response.json({
    id: student.id, admissionNo: student.admission_no, firstName: student.first_name,
    lastName: student.last_name, otherNames: student.other_names,
    dateOfBirth: student.date_of_birth ? decryptPii(student.date_of_birth) : null,
    gender: student.gender, status: student.status,
  });
}));

academicsRoutes.patch("/students/:id/archive", ...route("students:write", async (request, response) => {
  const id = parseId(request.params.id);
  parseBody(z.object({}).strict(), request.body ?? {});
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql`UPDATE students SET status = 'archived', updated_at = now() WHERE id = ${id}::uuid RETURNING id`.execute(tx);
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Student not found");
  await recordAudit(tx, { schoolId, userId, action: "student.archived", resourceType: "student", resourceId: id });
  response.json({ id, status: "archived" });
}));

academicsRoutes.post("/students/:id/guardians", ...route("students:write", async (request, response) => {
  const studentId = parseId(request.params.id);
  const input = parseBody(guardianSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO guardians (school_id, student_id, name, relationship, phone, is_primary)
    SELECT school_id, id, ${input.name}, ${input.relationship}, ${encryptPii(input.phone)}, ${input.isPrimary}
    FROM students WHERE id = ${studentId}::uuid RETURNING id
  `.execute(tx);
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Student not found");
  await recordAudit(tx, { schoolId, userId, action: "guardian.created", resourceType: "guardian", resourceId: result.rows[0].id });
  response.status(201).json({ id: result.rows[0].id, ...input });
}));

academicsRoutes.get("/students/:id/guardians", ...route("students:read", async (request, response) => {
  const studentId = parseId(request.params.id);
  const { tx } = context(request);
  const student = await sql`SELECT id FROM students WHERE id = ${studentId}::uuid`.execute(tx);
  if (!student.rows[0]) throw new HttpError(404, "NOT_FOUND", "Student not found");
  const rows = await sql<{ id: string; name: string; relationship: string; phone: string; is_primary: boolean }>`
    SELECT id, name, relationship, phone, is_primary FROM guardians WHERE student_id = ${studentId}::uuid ORDER BY is_primary DESC, name
  `.execute(tx);
  response.json({ items: rows.rows.map((guardian) => ({
    id: guardian.id, name: guardian.name, relationship: guardian.relationship,
    phone: decryptPii(guardian.phone), isPrimary: guardian.is_primary,
  })) });
}));

academicsRoutes.post("/students/:id/enrollments", ...route("students:write", async (request, response) => {
  const studentId = parseId(request.params.id);
  const input = parseBody(enrollmentSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id)
    SELECT st.school_id, st.id, c.id, c.academic_year_id
    FROM students st JOIN classes c ON c.school_id = st.school_id
    WHERE st.id = ${studentId}::uuid AND c.id = ${input.classId}::uuid
      AND c.academic_year_id = ${input.academicYearId}::uuid
    RETURNING id
  `.execute(tx);
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Student, class, or academic year not found");
  await recordAudit(tx, { schoolId, userId, action: "enrollment.created", resourceType: "enrollment", resourceId: result.rows[0].id });
  response.status(201).json({ id: result.rows[0].id, studentId, ...input, status: "active" });
}));

academicsRoutes.get("/enrollments", ...route("students:read", async (request, response) => {
  const filters = z.object({ academicYearId: idSchema.optional(), classId: idSchema.optional() }).safeParse(request.query);
  if (!filters.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", filters.error.issues);
  const { tx } = context(request);
  const rows = await sql`
    SELECT e.id, e.student_id AS "studentId", e.class_id AS "classId",
      e.academic_year_id AS "academicYearId", e.status
    FROM enrollments e
    WHERE (${filters.data.academicYearId ?? null}::uuid IS NULL OR e.academic_year_id = ${filters.data.academicYearId ?? null}::uuid)
      AND (${filters.data.classId ?? null}::uuid IS NULL OR e.class_id = ${filters.data.classId ?? null}::uuid)
    ORDER BY e.created_at DESC
  `.execute(tx);
  response.json({ items: rows.rows });
}));

academicsRoutes.post("/enrollments/promote-class", ...route("students:write", async (request, response) => {
  const input = parseBody(promoteSchema, request.body);
  const studentIds = [...new Set(input.studentIds)];
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const classYear = await sql<{ academic_year_id: string }>`SELECT academic_year_id FROM classes WHERE id = ${input.classId}::uuid`.execute(tx);
  if (!classYear.rows[0] || classYear.rows[0].academic_year_id !== input.academicYearId) {
    throw new HttpError(404, "NOT_FOUND", "Class or academic year not found");
  }
  const students = await sql`SELECT id FROM students WHERE id = ANY(${studentIds}::uuid[])`.execute(tx);
  if (students.rows.length !== studentIds.length) throw new HttpError(404, "NOT_FOUND", "One or more students not found");
  await sql`
    UPDATE enrollments SET status = 'completed'
    WHERE student_id = ANY(${studentIds}::uuid[]) AND academic_year_id <> ${input.academicYearId}::uuid AND status = 'active'
  `.execute(tx);
  const inserted = await sql<{ id: string; student_id: string }>`
    INSERT INTO enrollments (school_id, student_id, class_id, academic_year_id)
    SELECT ${schoolId}::uuid, student_id, ${input.classId}::uuid, ${input.academicYearId}::uuid
    FROM unnest(${studentIds}::uuid[]) AS student_id
    ON CONFLICT (school_id, student_id, academic_year_id) WHERE status = 'active' DO NOTHING
    RETURNING id, student_id
  `.execute(tx);
  await recordAudit(tx, { schoolId, userId, action: "enrollments.promoted", resourceType: "enrollment", metadata: { studentIds, classId: input.classId, academicYearId: input.academicYearId } });
  response.status(200).json({ items: inserted.rows.map((row) => ({ id: row.id, studentId: row.student_id })) });
}));

academicsRoutes.get("/grading-schemes", ...route("students:read", async (request, response) => {
  const { tx } = context(request);
  const schemes = await sql<Record<string, unknown> & { id: string }>`SELECT * FROM grading_schemes ORDER BY level_from, name`.execute(tx);
  const bands = await sql<Record<string, unknown> & { scheme_id: string }>`SELECT * FROM grade_bands ORDER BY scheme_id, min_score`.execute(tx);
  const overrides = await sql<Record<string, unknown> & { scheme_id: string }>`SELECT * FROM grading_scheme_overrides ORDER BY scheme_id, subject_id, level`.execute(tx);
  response.json({ items: schemes.rows.map((scheme) => ({
    ...scheme,
    bands: bands.rows.filter((band) => band.scheme_id === scheme.id),
    overrides: overrides.rows.filter((override) => override.scheme_id === scheme.id),
  })) });
}));

academicsRoutes.post("/grading-schemes", ...route("grading:manage", async (request, response) => {
  const input = parseBody(schemeSchema, request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const result = await sql<{ id: string }>`
    INSERT INTO grading_schemes (school_id, name, description, level_from, level_to, scale_type, lower_is_better, class_score_weight, exam_weight, is_default)
    VALUES (${schoolId}::uuid, ${input.name}, ${input.description}, ${input.levelFrom}, ${input.levelTo}, ${input.scaleType}, ${input.lowerIsBetter}, ${input.classScoreWeight}, ${input.examWeight}, ${input.isDefault})
    RETURNING id
  `.execute(tx);
  const id = result.rows[0]!.id;
  await recordAudit(tx, { schoolId, userId, action: "grading_scheme.created", resourceType: "grading_scheme", resourceId: id });
  response.status(201).json({ id, ...input });
}));

academicsRoutes.put("/grading-schemes/:id", ...route("grading:manage", async (request, response) => {
  const id = parseId(request.params.id);
  const input = parseBody(schemeUpdateSchema, request.body);
  if (Object.keys(input).length === 0) {
    throw new HttpError(400, "VALIDATION_ERROR", "Provide at least one field to update");
  }
  if ((input.classScoreWeight !== undefined || input.examWeight !== undefined) &&
      (input.classScoreWeight === undefined || input.examWeight === undefined || input.classScoreWeight + input.examWeight !== 100)) {
    throw new HttpError(400, "VALIDATION_ERROR", "Assessment weights must be updated together and total 100");
  }
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const updated = await sql<{ id: string }>`
    UPDATE grading_schemes SET
      name = COALESCE(${input.name ?? null}, name),
      description = COALESCE(${input.description ?? null}, description),
      level_from = COALESCE(${input.levelFrom ?? null}, level_from),
      level_to = COALESCE(${input.levelTo ?? null}, level_to),
      scale_type = COALESCE(${input.scaleType ?? null}, scale_type),
      lower_is_better = COALESCE(${input.lowerIsBetter ?? null}, lower_is_better),
      class_score_weight = COALESCE(${input.classScoreWeight ?? null}, class_score_weight),
      exam_weight = COALESCE(${input.examWeight ?? null}, exam_weight),
      is_default = COALESCE(${input.isDefault ?? null}, is_default)
    WHERE id = ${id}::uuid RETURNING id
  `.execute(tx);
  if (!updated.rows[0]) throw new HttpError(404, "NOT_FOUND", "Grading scheme not found");
  const levelRange = await sql<{ level_from: number; level_to: number }>`
    SELECT level_from, level_to FROM grading_schemes WHERE id = ${id}::uuid
  `.execute(tx);
  if (levelRange.rows[0]!.level_from > levelRange.rows[0]!.level_to) {
    throw new HttpError(400, "VALIDATION_ERROR", "levelFrom must not exceed levelTo");
  }
  await recordAudit(tx, { schoolId, userId, action: "grading_scheme.updated", resourceType: "grading_scheme", resourceId: id });
  response.json({ id, ...input });
}));

academicsRoutes.put("/grading-schemes/:id/bands", ...route("grading:manage", async (request, response) => {
  const id = parseId(request.params.id);
  const input = parseBody(z.array(bandSchema).min(1).max(101), request.body);
  const ordered = [...input].sort((a, b) => a.minScore - b.minScore);
  if (ordered[0]!.minScore !== 0 || ordered.at(-1)!.maxScore !== 100 || ordered.some((band, index) => band.minScore > band.maxScore || (index > 0 && band.minScore !== ordered[index - 1]!.maxScore + 1))) {
    throw new HttpError(400, "INVALID_GRADE_BANDS", "Bands must cover 0-100 using whole numbers without gaps or overlaps");
  }
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const scheme = await sql`SELECT id FROM grading_schemes WHERE id = ${id}::uuid`.execute(tx);
  if (!scheme.rows[0]) throw new HttpError(404, "NOT_FOUND", "Grading scheme not found");
  await sql`DELETE FROM grade_bands WHERE scheme_id = ${id}::uuid`.execute(tx);
  for (const band of ordered) {
    await sql`INSERT INTO grade_bands (school_id, scheme_id, min_score, max_score, label, points, descriptor, is_credit, is_pass)
      VALUES (${schoolId}::uuid, ${id}::uuid, ${band.minScore}, ${band.maxScore}, ${band.label}, ${band.points ?? null}, ${band.descriptor ?? null}, ${band.isCredit}, ${band.isPass})`.execute(tx);
  }
  await recordAudit(tx, { schoolId, userId, action: "grading_scheme.bands_updated", resourceType: "grading_scheme", resourceId: id });
  response.json({ schemeId: id, bands: ordered });
}));

academicsRoutes.put("/grading-schemes/:id/overrides", ...route("grading:manage", async (request, response) => {
  const id = parseId(request.params.id);
  const input = parseBody(z.array(overrideSchema).max(200), request.body);
  const { tx } = context(request);
  const { schoolId, userId } = actor(request);
  const scheme = await sql`SELECT id FROM grading_schemes WHERE id = ${id}::uuid`.execute(tx);
  if (!scheme.rows[0]) throw new HttpError(404, "NOT_FOUND", "Grading scheme not found");
  await sql`DELETE FROM grading_scheme_overrides WHERE scheme_id = ${id}::uuid`.execute(tx);
  for (const override of input) {
    await sql`INSERT INTO grading_scheme_overrides (school_id, scheme_id, subject_id, level, class_score_weight, exam_weight)
      VALUES (${schoolId}::uuid, ${id}::uuid, ${override.subjectId ?? null}::uuid, ${override.level ?? null}, ${override.classScoreWeight}, ${override.examWeight})`.execute(tx);
  }
  await recordAudit(tx, { schoolId, userId, action: "grading_scheme.overrides_updated", resourceType: "grading_scheme", resourceId: id });
  response.json({ schemeId: id, overrides: input });
}));