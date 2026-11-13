import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { recomputeTermAttendance } from "./result-service";
import { HttpError } from "../shared/errors/http-error";
import { asyncHandler } from "../shared/middleware/async-handler";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";
import { can } from "../shared/rbac/can";

const idSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const attendanceRowSchema = z.object({
  clientId: idSchema,
  studentId: idSchema,
  status: z.enum(["present", "absent", "late", "excused"]),
  version: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  enteredAt: z.string().datetime().optional(),
}).strict();
const closureSchema = z.object({
  startDate: dateSchema,
  endDate: dateSchema,
  reason: z.string().trim().min(1).max(500),
}).strict().refine((value) => value.startDate <= value.endDate, {
  message: "startDate must not be after endDate",
  path: ["endDate"],
});

export const attendanceRoutes = Router();
attendanceRoutes.use(tenantContext);

function context(request: RequestWithTenant) {
  return request.tenantContext;
}

function actor(request: RequestWithTenant) {
  const { claims } = context(request);
  return {
    userId: claims.userId,
    schoolId: claims.schoolId!,
    membershipId: claims.membershipId!,
  };
}

async function authorizeClass(
  request: RequestWithTenant,
  classId: string,
  permission: "attendance:read" | "attendance:write",
): Promise<void> {
  const currentActor = actor(request);
  const allowed = await can(currentActor, permission, context(request).tx, {
    type: "class",
    id: classId,
  });
  if (!allowed) {
    await recordAudit(context(request).tx, {
      schoolId: currentActor.schoolId,
      userId: currentActor.userId,
      action: "authorization.denied",
      resourceType: "class",
      resourceId: classId,
      metadata: { permission },
    });
    throw new HttpError(404, "NOT_FOUND", "Resource not found");
  }
}

async function dateAndTerm(
  request: RequestWithTenant,
  classId: string,
  date: string,
): Promise<{ academicYearId: string; termId: string; termStatus: string }> {
  const { tx } = context(request);
  const result = await sql<{
    academic_year_id: string;
    term_id: string;
    term_status: string;
  }>`
    SELECT c.academic_year_id, t.id AS term_id, t.status AS term_status
    FROM classes c
    JOIN terms t
      ON t.school_id = c.school_id AND t.academic_year_id = c.academic_year_id
    WHERE c.id = ${classId}::uuid
      AND ${date}::date BETWEEN t.start_date AND t.end_date
      AND ${date}::date <= CURRENT_DATE
    ORDER BY t.term_number
    LIMIT 1
  `.execute(tx);
  if (!result.rows[0]) {
    const classExists = await sql`SELECT id FROM classes WHERE id = ${classId}::uuid`.execute(tx);
    if (!classExists.rows[0]) throw new HttpError(404, "NOT_FOUND", "Class not found");
    const future = await sql<{ future: boolean }>`SELECT ${date}::date > CURRENT_DATE AS future`.execute(tx);
    if (future.rows[0]?.future) throw new HttpError(400, "FUTURE_REGISTER_DATE", "Registers cannot be taken for future dates");
    throw new HttpError(400, "DATE_OUTSIDE_TERM", "Register date must fall within a term");
  }
  return {
    academicYearId: result.rows[0].academic_year_id,
    termId: result.rows[0].term_id,
    termStatus: result.rows[0].term_status,
  };
}

attendanceRoutes.get(
  "/classes/:id/registers/:date",
  asyncHandler(async (request, response) => {
    const classId = idSchema.safeParse(request.params.id);
    const date = dateSchema.safeParse(request.params.date);
    if (!classId.success || !date.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", [
        ...(!classId.success ? classId.error.issues : []),
        ...(!date.success ? date.error.issues : []),
      ]);
    }
    const currentRequest = request as RequestWithTenant;
    const currentActor = actor(currentRequest);
    const { tx } = context(currentRequest);
    await authorizeClass(currentRequest, classId.data, "attendance:read");
    const term = await dateAndTerm(currentRequest, classId.data, date.data);
    const registerResult = await sql<{
      id: string;
      status: string;
      submitted_at: string | null;
    }>`
      SELECT id, status, submitted_at
      FROM attendance_registers
      WHERE school_id = ${currentActor.schoolId}::uuid
        AND class_id = ${classId.data}::uuid
        AND register_date = ${date.data}::date
    `.execute(tx);
    const register = registerResult.rows[0];
    const roster = await sql<{
      student_id: string;
      roll_number: number;
      first_name: string;
      last_name: string;
      other_names: string | null;
      status: string | null;
      client_id: string | null;
      version: number | null;
    }>`
      SELECT e.student_id, e.roll_number, s.first_name, s.last_name, s.other_names,
        a.status, a.client_id, a.version
      FROM enrollments e
      JOIN students s ON s.school_id = e.school_id AND s.id = e.student_id
      LEFT JOIN attendance a
        ON a.school_id = e.school_id AND a.register_id = ${register?.id ?? null}::uuid
        AND a.student_id = e.student_id
      WHERE e.school_id = ${currentActor.schoolId}::uuid
        AND e.class_id = ${classId.data}::uuid
        AND e.academic_year_id = ${term.academicYearId}::uuid
        AND e.status = 'active'
        AND e.start_date <= ${date.data}::date
        AND (e.end_date IS NULL OR e.end_date >= ${date.data}::date)
      ORDER BY e.roll_number
    `.execute(tx);
    response.json({
      register: {
        id: register?.id ?? null,
        date: date.data,
        status: register?.status ?? "draft",
        submittedAt: register?.submitted_at ?? null,
      },
      items: roster.rows.map((item) => ({
        studentId: item.student_id,
        rollNumber: item.roll_number,
        name: [item.first_name, item.other_names, item.last_name].filter(Boolean).join(" "),
        status: item.status ?? "present",
        clientId: item.client_id,
        version: item.version ?? 0,
      })),
    });
  }),
);

attendanceRoutes.get(
  "/school-closures",
  asyncHandler(async (request, response) => {
    const filters = z.object({
      from: dateSchema.optional(),
      to: dateSchema.optional(),
    }).strict().safeParse(request.query);
    if (!filters.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", filters.error.issues);
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    const allowed = await can(currentActor, "attendance:read", tx);
    if (!allowed) {
      await recordAudit(tx, {
        schoolId: currentActor.schoolId,
        userId: currentActor.userId,
        action: "authorization.denied",
        resourceType: "permission",
        metadata: { permission: "attendance:read" },
      });
      throw new HttpError(403, "FORBIDDEN", "Permission denied");
    }
    const rows = await sql`
      SELECT id, start_date AS "startDate", end_date AS "endDate", reason
      FROM school_closures
      WHERE school_id = ${currentActor.schoolId}::uuid
        AND (${filters.data.from ?? null}::date IS NULL OR end_date >= ${filters.data.from ?? null}::date)
        AND (${filters.data.to ?? null}::date IS NULL OR start_date <= ${filters.data.to ?? null}::date)
      ORDER BY start_date
    `.execute(tx);
    response.json({ items: rows.rows });
  }),
);

attendanceRoutes.post(
  "/school-closures",
  asyncHandler(async (request, response) => {
    const parsed = closureSchema.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    const allowed = await can(currentActor, "academics:manage", tx);
    if (!allowed) {
      await recordAudit(tx, {
        schoolId: currentActor.schoolId,
        userId: currentActor.userId,
        action: "authorization.denied",
        resourceType: "permission",
        metadata: { permission: "academics:manage" },
      });
      throw new HttpError(403, "FORBIDDEN", "Permission denied");
    }
    const inserted = await sql<{ id: string }>`
      INSERT INTO school_closures (school_id, start_date, end_date, reason)
      VALUES (
        ${currentActor.schoolId}::uuid, ${parsed.data.startDate}::date,
        ${parsed.data.endDate}::date, ${parsed.data.reason}
      ) RETURNING id
    `.execute(tx);
    const id = inserted.rows[0]!.id;
    await recordAudit(tx, {
      schoolId: currentActor.schoolId,
      userId: currentActor.userId,
      action: "school_closure.created",
      resourceType: "school_closure",
      resourceId: id,
    });
    response.status(201).json({ id, ...parsed.data });
  }),
);

attendanceRoutes.delete(
  "/school-closures/:id",
  asyncHandler(async (request, response) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", id.error.issues);
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    const allowed = await can(currentActor, "academics:manage", tx);
    if (!allowed) {
      await recordAudit(tx, {
        schoolId: currentActor.schoolId,
        userId: currentActor.userId,
        action: "authorization.denied",
        resourceType: "permission",
        metadata: { permission: "academics:manage" },
      });
      throw new HttpError(403, "FORBIDDEN", "Permission denied");
    }
    const result = await sql`DELETE FROM school_closures WHERE id = ${id.data}::uuid RETURNING id`.execute(tx);
    if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "School closure not found");
    await recordAudit(tx, {
      schoolId: currentActor.schoolId,
      userId: currentActor.userId,
      action: "school_closure.deleted",
      resourceType: "school_closure",
      resourceId: id.data,
    });
    response.status(204).end();
  }),
);

attendanceRoutes.put(
  "/classes/:id/registers/:date",
  asyncHandler(async (request, response) => {
    const classId = idSchema.safeParse(request.params.id);
    const date = dateSchema.safeParse(request.params.date);
    const body = z.object({
      items: z.array(z.unknown()).max(500),
      submit: z.boolean().default(false),
    }).strict().safeParse(request.body);
    if (!classId.success || !date.success || !body.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", [
        ...(!classId.success ? classId.error.issues : []),
        ...(!date.success ? date.error.issues : []),
        ...(!body.success ? body.error.issues : []),
      ]);
    }
    const currentRequest = request as RequestWithTenant;
    const currentActor = actor(currentRequest);
    const { tx } = context(currentRequest);
    await authorizeClass(currentRequest, classId.data, "attendance:write");
    const term = await dateAndTerm(currentRequest, classId.data, date.data);
    const rosterResult = await sql<{ student_id: string }>`
      SELECT student_id FROM enrollments
      WHERE school_id = ${currentActor.schoolId}::uuid
        AND class_id = ${classId.data}::uuid
        AND academic_year_id = ${term.academicYearId}::uuid
        AND status = 'active'
        AND start_date <= ${date.data}::date
        AND (end_date IS NULL OR end_date >= ${date.data}::date)
      ORDER BY student_id
    `.execute(tx);
    const roster = new Set(rosterResult.rows.map((row) => row.student_id));
    const registerInsert = await sql<{ id: string }>`
      INSERT INTO attendance_registers (
        school_id, academic_year_id, class_id, register_date, taken_by
      ) VALUES (
        ${currentActor.schoolId}::uuid, ${term.academicYearId}::uuid,
        ${classId.data}::uuid, ${date.data}::date, ${currentActor.membershipId}::uuid
      )
      ON CONFLICT (school_id, class_id, register_date) DO NOTHING
      RETURNING id
    `.execute(tx);
    const registerId = registerInsert.rows[0]?.id ??
      (await sql<{ id: string; status: string }>`
        SELECT id, status FROM attendance_registers
        WHERE school_id = ${currentActor.schoolId}::uuid
          AND class_id = ${classId.data}::uuid
          AND register_date = ${date.data}::date
        FOR UPDATE
      `.execute(tx)).rows[0]?.id;
    if (!registerId) throw new Error("Attendance register could not be opened");
    const registerState = await sql<{ status: string }>`
      SELECT status FROM attendance_registers WHERE id = ${registerId}::uuid FOR UPDATE
    `.execute(tx);
    if (registerInsert.rows[0]) {
      await recordAudit(tx, {
        schoolId: currentActor.schoolId,
        userId: currentActor.userId,
        action: "attendance_register.opened",
        resourceType: "attendance_register",
        resourceId: registerId,
        metadata: { classId: classId.data, date: date.data },
      });
    }

    const outcomes: Record<string, unknown>[] = [];
    const seenStudents = new Set<string>();
    const seenClients = new Set<string>();
    let rowsOkay = true;
    for (const rawItem of body.data.items) {
      const rawClientId = typeof rawItem === "object" && rawItem !== null &&
        "clientId" in rawItem && typeof rawItem.clientId === "string"
        ? rawItem.clientId
        : "";
      const parsed = attendanceRowSchema.safeParse(rawItem);
      if (!parsed.success) {
        rowsOkay = false;
        outcomes.push({
          clientId: rawClientId,
          outcome: "rejected",
          reason: parsed.error.issues[0]?.message ?? "Invalid attendance row",
        });
        continue;
      }
      const item = parsed.data;
      if (seenStudents.has(item.studentId) || seenClients.has(item.clientId)) {
        rowsOkay = false;
        outcomes.push({ clientId: item.clientId, outcome: "rejected", reason: "DUPLICATE_ROW" });
        continue;
      }
      seenStudents.add(item.studentId);
      seenClients.add(item.clientId);
      if (!roster.has(item.studentId)) {
        rowsOkay = false;
        outcomes.push({ clientId: item.clientId, outcome: "rejected", reason: "STUDENT_NOT_ENROLLED" });
        continue;
      }

      const replay = await sql<{
        attendance_id: string;
        register_id: string | null;
        student_id: string;
        status: string;
        version: number;
      }>`
        SELECT v.attendance_id, a.register_id, a.student_id, a.status, a.version
        FROM attendance_versions v
        JOIN attendance a ON a.school_id = v.school_id AND a.id = v.attendance_id
        WHERE v.school_id = ${currentActor.schoolId}::uuid
          AND v.client_id = ${item.clientId}::uuid
      `.execute(tx);
      if (replay.rows[0]) {
        const existing = replay.rows[0];
        if (existing.register_id !== registerId || existing.student_id !== item.studentId) {
          rowsOkay = false;
          outcomes.push({ clientId: item.clientId, outcome: "rejected", reason: "CLIENT_ID_REUSED" });
        } else {
          outcomes.push({
            clientId: item.clientId,
            outcome: "applied",
            currentStatus: existing.status,
            currentVersion: existing.version,
          });
        }
        continue;
      }

      let approvalReason: string | null = null;
      if (term.termStatus === "locked") {
        const approved = await can(currentActor, "terms:lock", tx);
        if (!approved || !item.reason) {
          rowsOkay = false;
          if (!approved) {
            await recordAudit(tx, {
              schoolId: currentActor.schoolId,
              userId: currentActor.userId,
              action: "authorization.denied",
              resourceType: "term",
              resourceId: term.termId,
              metadata: { permission: "terms:lock" },
            });
          }
          outcomes.push({
            clientId: item.clientId,
            outcome: "rejected",
            reason: !approved ? "TERM_LOCKED" : "APPROVAL_REASON_REQUIRED",
          });
          continue;
        }
        approvalReason = item.reason;
      }

      const currentResult = await sql<{
        id: string;
        status: string;
        version: number;
      }>`
        SELECT id, status, version FROM attendance
        WHERE school_id = ${currentActor.schoolId}::uuid
          AND register_id = ${registerId}::uuid
          AND student_id = ${item.studentId}::uuid
        FOR UPDATE
      `.execute(tx);
      const current = currentResult.rows[0];
      if (current && item.version !== undefined && item.version !== current.version) {
        rowsOkay = false;
        outcomes.push({
          clientId: item.clientId,
          outcome: "conflict",
          currentStatus: current.status,
          currentVersion: current.version,
        });
        continue;
      }
      let version: number;
      let oldStatus: string | null = null;
      let attendanceId: string;
      if (current) {
        version = current.version + 1;
        attendanceId = current.id;
        oldStatus = current.status;
        await sql`
          UPDATE attendance SET status = ${item.status},
            entered_by = ${currentActor.membershipId}::uuid, entered_at = ${item.enteredAt ?? null},
            version = ${version}
          WHERE id = ${current.id}::uuid
        `.execute(tx);
      } else {
        const inserted = await sql<{ id: string }>`
          INSERT INTO attendance (
            school_id, student_id, class_id, attendance_date, register_id,
            status, entered_by, client_id, entered_at
          ) VALUES (
            ${currentActor.schoolId}::uuid, ${item.studentId}::uuid, ${classId.data}::uuid,
            ${date.data}::date, ${registerId}::uuid, ${item.status},
            ${currentActor.membershipId}::uuid, ${item.clientId}::uuid, ${item.enteredAt ?? null}
          ) RETURNING id
        `.execute(tx);
        attendanceId = inserted.rows[0]!.id;
        version = 1;
      }
      await sql`
        INSERT INTO attendance_versions (
          school_id, attendance_id, old_status, new_status, changed_by,
          client_id, reason, entered_at
        ) VALUES (
          ${currentActor.schoolId}::uuid, ${attendanceId}::uuid, ${oldStatus},
          ${item.status}, ${currentActor.membershipId}::uuid, ${item.clientId}::uuid,
          ${approvalReason}, ${item.enteredAt ?? null}
        )
      `.execute(tx);
      await recordAudit(tx, {
        schoolId: currentActor.schoolId,
        userId: currentActor.userId,
        action: current ? "attendance.updated" : "attendance.created",
        resourceType: "attendance",
        reason: approvalReason,
        metadata: {
          clientId: item.clientId,
          enteredAt: item.enteredAt ?? null,
          version,
          status: item.status,
          approvedLockedTerm: term.termStatus === "locked",
        },
      });
      outcomes.push({
        clientId: item.clientId,
        outcome: "applied",
        currentStatus: item.status,
        currentVersion: version,
      });
    }

    if (body.data.submit) {
      if (rowsOkay) {
        await sql`
          UPDATE attendance_registers SET status = 'submitted', submitted_at = now(),
            taken_by = ${currentActor.membershipId}::uuid
          WHERE id = ${registerId}::uuid
        `.execute(tx);
        if (registerState.rows[0]?.status !== "submitted") {
          await recordAudit(tx, {
            schoolId: currentActor.schoolId,
            userId: currentActor.userId,
            action: "attendance_register.submitted",
            resourceType: "attendance_register",
            resourceId: registerId,
            metadata: { classId: classId.data, date: date.data },
          });
        }
      }
    }
    if (rowsOkay && (body.data.submit || registerState.rows[0]?.status === "submitted")) {
      await recomputeTermAttendance(tx, currentActor.schoolId, term.termId);
    }
    response.json({
      registerId,
      submitted: body.data.submit && rowsOkay,
      items: outcomes,
    });
  }),
);
