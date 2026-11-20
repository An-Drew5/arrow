import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { HttpError } from "../shared/errors/http-error";
import { asyncHandler } from "../shared/middleware/async-handler";
import { requirePermission } from "../shared/middleware/require-permission";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";

const idSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const assignmentSchema = z.object({
  membershipId: idSchema,
  classId: idSchema,
  subjectId: idSchema.nullable().optional(),
  type: z.enum(["subject", "class_teacher", "all_subjects"]).optional(),
  academicYearId: idSchema,
  startDate: dateSchema,
  endDate: dateSchema.nullable().optional(),
}).strict();

export const teacherRoutes = Router();
teacherRoutes.use(tenantContext);

teacherRoutes.post(
  "/teacher-assignments",
  requirePermission("academics:manage"),
  asyncHandler(async (request, response) => {
    const parsed = assignmentSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
    }
    const { tx, claims } = (request as RequestWithTenant).tenantContext;
    const classExists = await sql`SELECT id FROM classes
      WHERE id = ${parsed.data.classId}::uuid
        AND academic_year_id = ${parsed.data.academicYearId}::uuid`.execute(tx);
    const membership = await sql`SELECT id FROM memberships
      WHERE id = ${parsed.data.membershipId}::uuid`.execute(tx);
    if (!classExists.rows[0] || !membership.rows[0]) {
      throw new HttpError(404, "NOT_FOUND", "Class or teacher membership not found");
    }
    if (parsed.data.subjectId) {
      const classSubject = await sql`SELECT id FROM class_subjects
        WHERE class_id = ${parsed.data.classId}::uuid
          AND subject_id = ${parsed.data.subjectId}::uuid`.execute(tx);
      if (!classSubject.rows[0]) {
        throw new HttpError(404, "NOT_FOUND", "Subject is not assigned to this class");
      }
    }
    const type = parsed.data.type ?? (parsed.data.subjectId ? "subject" : "class_teacher");
    if ((type === "subject") !== (parsed.data.subjectId != null)) {
      throw new HttpError(400, "VALIDATION_ERROR", "Subject assignments require a subject; class assignments do not");
    }
    if (type === "all_subjects") {
      const teacherRoles = await sql<{ has_class_teacher: boolean; has_subject_teacher: boolean }>`
        SELECT
          coalesce(bool_or(r.name = 'class_teacher'), false) AS has_class_teacher,
          coalesce(bool_or(r.name = 'subject_teacher'), false) AS has_subject_teacher
        FROM membership_roles mr
        JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
        WHERE mr.school_id = ${claims.schoolId!}::uuid
          AND mr.membership_id = ${parsed.data.membershipId}::uuid
      `.execute(tx);
      if (
        !teacherRoles.rows[0]?.has_class_teacher ||
        !teacherRoles.rows[0]?.has_subject_teacher
      ) {
        throw new HttpError(
          400,
          "ALL_SUBJECTS_REQUIRES_TEACHER_ROLES",
          "All-subject assignments require both class_teacher and subject_teacher roles",
        );
      }
    }

    const assignment = await sql<{ id: string }>`
      INSERT INTO teacher_assignments (
        school_id, membership_id, class_id, subject_id, academic_year_id,
        assignment_type, start_date, end_date
      ) VALUES (
        ${claims.schoolId!}::uuid, ${parsed.data.membershipId}::uuid,
        ${parsed.data.classId}::uuid, ${parsed.data.subjectId ?? null}::uuid,
        ${parsed.data.academicYearId}::uuid, ${type},
        ${parsed.data.startDate}, ${parsed.data.endDate ?? null}
      ) RETURNING id
    `.execute(tx);
    const id = assignment.rows[0]!.id;
    await recordAudit(tx, {
      schoolId: claims.schoolId!,
      userId: claims.userId,
      action: "teacher_assignment.created",
      resourceType: "teacher_assignment",
      resourceId: id,
    });
    response.status(201).json({ id, ...parsed.data, type });
  }),
);

teacherRoutes.get(
  "/teacher-assignments",
  requirePermission("academics:manage"),
  asyncHandler(async (request, response) => {
    const { tx } = (request as RequestWithTenant).tenantContext;
    const membershipId = typeof request.query.membershipId === "string"
      ? idSchema.parse(request.query.membershipId)
      : undefined;
    const assignments = membershipId
      ? await sql`SELECT id, membership_id AS "membershipId", class_id AS "classId",
          subject_id AS "subjectId", academic_year_id AS "academicYearId",
        assignment_type AS type, start_date AS "startDate", end_date AS "endDate"
        FROM teacher_assignments WHERE membership_id = ${membershipId}::uuid
        ORDER BY start_date DESC`.execute(tx)
      : await sql`SELECT id, membership_id AS "membershipId", class_id AS "classId",
          subject_id AS "subjectId", academic_year_id AS "academicYearId",
        assignment_type AS type, start_date AS "startDate", end_date AS "endDate"
        FROM teacher_assignments ORDER BY start_date DESC`.execute(tx);
    response.json({ items: assignments.rows });
  }),
);

teacherRoutes.patch(
  "/teacher-assignments/:id",
  requirePermission("academics:manage"),
  asyncHandler(async (request, response) => {
    const id = idSchema.safeParse(request.params.id);
    const body = z.object({ endDate: dateSchema.nullable() }).strict().safeParse(request.body);
    if (!id.success || !body.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", [
        ...(!id.success ? id.error.issues : []),
        ...(!body.success ? body.error.issues : []),
      ]);
    }
    const { tx, claims } = (request as RequestWithTenant).tenantContext;
    const updated = await sql<{ id: string }>`
      UPDATE teacher_assignments SET end_date = ${body.data.endDate}
      WHERE id = ${id.data}::uuid RETURNING id
    `.execute(tx);
    if (!updated.rows[0]) throw new HttpError(404, "NOT_FOUND", "Teacher assignment not found");
    await recordAudit(tx, {
      schoolId: claims.schoolId!, userId: claims.userId,
      action: "teacher_assignment.updated", resourceType: "teacher_assignment", resourceId: id.data,
    });
    response.json({ id: id.data, endDate: body.data.endDate });
  }),
);