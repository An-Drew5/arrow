import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { computeTermResults } from "./result-service";
import { HttpError } from "../shared/errors/http-error";
import { asyncHandler } from "../shared/middleware/async-handler";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";
import { can } from "../shared/rbac/can";
import { ordinalLabel } from "./computation";

const idSchema = z.string().uuid();
const markSchema = z.union([
  z.number().nonnegative().refine((value) => Number.isSafeInteger(value * 10)),
  z.string().regex(/^\d+(?:\.\d)?$/),
]);
const scoreRowSchema = z.object({
  clientId: idSchema,
  studentId: idSchema,
  mark: markSchema.nullable().optional(),
  status: z.enum(["scored", "absent", "excused"]),
  version: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  enteredAt: z.string().datetime().optional(),
}).strict();

export const academicCoreRoutes = Router();
academicCoreRoutes.use(tenantContext);

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

function assessmentScopePredicate(membershipId: string) {
  return sql`(
    EXISTS (
      SELECT 1 FROM membership_roles mr
      JOIN role_permissions rp
        ON rp.school_id = mr.school_id AND rp.role_id = mr.role_id
      WHERE mr.school_id = a.school_id
        AND mr.membership_id = ${membershipId}::uuid
        AND rp.permission IN ('academics:manage', 'terms:lock')
    )
    OR EXISTS (
      SELECT 1 FROM teacher_assignments ta
      JOIN academic_years ay
        ON ay.school_id = ta.school_id AND ay.id = ta.academic_year_id
      WHERE ta.school_id = a.school_id
        AND ta.membership_id = ${membershipId}::uuid
        AND ta.class_id = a.class_id
        AND ta.academic_year_id = a.academic_year_id
        AND ay.status = 'open'
        AND ta.start_date <= CURRENT_DATE
        AND (ta.end_date IS NULL OR ta.end_date >= CURRENT_DATE)
        AND (
          ta.assignment_type IN ('class_teacher', 'all_subjects')
          OR (ta.assignment_type = 'subject' AND ta.subject_id = a.subject_id)
        )
    )
  )`;
}

async function auditDenied(
  request: RequestWithTenant,
  permission: string,
  resourceType: string,
  resourceId?: string,
): Promise<void> {
  const currentActor = actor(request);
  await recordAudit(context(request).tx, {
    schoolId: currentActor.schoolId,
    userId: currentActor.userId,
    action: "authorization.denied",
    resourceType,
    ...(resourceId ? { resourceId } : {}),
    metadata: { permission },
  });
}

async function requireScope(
  request: RequestWithTenant,
  permission: "scores:read" | "scores:write" | "attendance:read" | "attendance:write" | "reports:read" | "terms:lock" | "results:compute",
  resource?: { type: string; id: string },
  hidden = false,
): Promise<void> {
  const currentActor = actor(request);
  const allowed = await can(currentActor, permission, context(request).tx, resource);
  if (!allowed) {
    await auditDenied(request, permission, resource?.type ?? "permission", resource?.id);
    throw new HttpError(hidden ? 404 : 403, hidden ? "NOT_FOUND" : "FORBIDDEN", hidden ? "Resource not found" : "Permission denied");
  }
}

academicCoreRoutes.put(
  "/assessments/:id/scores",
  asyncHandler(async (request, response) => {
    const assessmentId = idSchema.safeParse(request.params.id);
    if (!assessmentId.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", assessmentId.error.issues);
    }
    const batch = z.object({ items: z.array(z.unknown()).min(1).max(500) }).strict().safeParse(request.body);
    if (!batch.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", batch.error.issues);
    }
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    const assessmentResult = await sql<{
      id: string;
      class_id: string;
      subject_id: string;
      term_id: string;
      term_status: string;
      max_mark: string;
    }>`
      SELECT a.id, a.class_id, a.subject_id, a.term_id, t.status AS term_status,
        a.max_mark::text AS max_mark
      FROM assessments a
      JOIN terms t ON t.school_id = a.school_id AND t.id = a.term_id
      WHERE a.school_id = ${currentActor.schoolId}::uuid
        AND a.id = ${assessmentId.data}::uuid
    `.execute(tx)
    const assessment = assessmentResult.rows[0];
    if (!assessment) throw new HttpError(404, "NOT_FOUND", "Assessment not found");
    await requireScope(request as RequestWithTenant, "scores:write", {
      type: "assessment",
      id: assessment.id,
    }, true);

    const outcomes: Record<string, unknown>[] = [];
    let hasAppliedWrite = false;
    for (const rawItem of batch.data.items) {
      const rawClientId = typeof rawItem === "object" && rawItem !== null &&
        "clientId" in rawItem && typeof rawItem.clientId === "string"
        ? rawItem.clientId
        : "";
      const parsed = scoreRowSchema.safeParse(rawItem);
      if (!parsed.success) {
        outcomes.push({
          clientId: rawClientId,
          outcome: "rejected",
          reason: parsed.error.issues[0]?.message ?? "Invalid score row",
        });
        continue;
      }
      const item = parsed.data;
      if ((item.status === "scored") !== (item.mark !== undefined && item.mark !== null)) {
        outcomes.push({ clientId: item.clientId, outcome: "rejected", reason: "MARK_STATUS_MISMATCH" });
        continue;
      }
      const mark = item.status === "scored" ? Number(item.mark) : null;
      if (mark !== null && (mark > Number(assessment.max_mark) || !Number.isSafeInteger(mark * 10))) {
        outcomes.push({ clientId: item.clientId, outcome: "rejected", reason: "MARK_OUT_OF_RANGE" });
        continue;
      }

      const enrolled = await sql`
        SELECT e.student_id
        FROM enrollments e
        WHERE e.school_id = ${currentActor.schoolId}::uuid
          AND e.student_id = ${item.studentId}::uuid
          AND e.class_id = ${assessment.class_id}::uuid
          AND e.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM student_subject_opt_outs o
            JOIN class_subjects cs
              ON cs.school_id = o.school_id AND cs.id = o.class_subject_id
            WHERE o.school_id = e.school_id AND o.student_id = e.student_id
              AND cs.class_id = e.class_id AND cs.subject_id = ${assessment.subject_id}::uuid
          )
      `.execute(tx);
      if (!enrolled.rows[0]) {
        outcomes.push({ clientId: item.clientId, outcome: "rejected", reason: "STUDENT_NOT_ENROLLED" });
        continue;
      }

      const replay = await sql<{
        score_id: string;
        assessment_id: string;
        student_id: string;
        mark: string | null;
        status: string;
        version: number;
      }>`
        SELECT sv.score_id, s.assessment_id, s.student_id, s.mark::text AS mark, s.status, s.version
        FROM score_versions sv
        JOIN scores s ON s.school_id = sv.school_id AND s.id = sv.score_id
        WHERE sv.school_id = ${currentActor.schoolId}::uuid AND sv.client_id = ${item.clientId}::uuid
      `.execute(tx);
      if (replay.rows[0]) {
        const existing = replay.rows[0];
        if (existing.assessment_id !== assessment.id || existing.student_id !== item.studentId) {
          outcomes.push({ clientId: item.clientId, outcome: "rejected", reason: "CLIENT_ID_REUSED" });
        } else {
          outcomes.push({
            clientId: item.clientId,
            outcome: "applied",
            currentMark: existing.mark === null ? null : Number(existing.mark),
            currentVersion: existing.version,
          });
        }
        continue;
      }

      let approvalReason: string | null = null;
      if (assessment.term_status === "locked") {
        const approved = await can(currentActor, "terms:lock", tx);
        if (!approved || !item.reason) {
          if (!approved) await auditDenied(request as RequestWithTenant, "terms:lock", "term", assessment.term_id);
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
        mark: string | null;
        status: string;
        version: number;
      }>`
        SELECT id, mark::text AS mark, status, version
        FROM scores
        WHERE school_id = ${currentActor.schoolId}::uuid
          AND assessment_id = ${assessment.id}::uuid
          AND student_id = ${item.studentId}::uuid
        FOR UPDATE
      `.execute(tx);
      const current = currentResult.rows[0];
      if (current && item.version !== undefined && item.version !== current.version) {
        outcomes.push({
          clientId: item.clientId,
          outcome: "conflict",
          currentMark: current.mark === null ? null : Number(current.mark),
          currentVersion: current.version,
        });
        continue;
      }

      let scoreId: string;
      let version: number;
      let oldMark: string | null = null;
      let oldStatus: string | null = null;
      if (current) {
        scoreId = current.id;
        oldMark = current.mark;
        oldStatus = current.status;
        version = current.version + 1;
        await sql`
          UPDATE scores SET mark = ${mark}, status = ${item.status},
            entered_by = ${currentActor.membershipId}::uuid,
            version = ${version}, entered_at = ${item.enteredAt ?? null}, updated_at = now()
          WHERE id = ${scoreId}::uuid
        `.execute(tx);
      } else {
        const inserted = await sql<{ id: string }>`
          INSERT INTO scores (
            school_id, assessment_id, student_id, mark, status, entered_by,
            version, client_id, entered_at
          ) VALUES (
            ${currentActor.schoolId}::uuid, ${assessment.id}::uuid, ${item.studentId}::uuid,
            ${mark}, ${item.status}, ${currentActor.membershipId}::uuid,
            1, ${item.clientId}::uuid, ${item.enteredAt ?? null}
          ) RETURNING id
        `.execute(tx);
        scoreId = inserted.rows[0]!.id;
        version = 1;
      }

      await sql`
        INSERT INTO score_versions (
        school_id, score_id, old_mark, new_mark, old_status, new_status,
        changed_by, reason, client_id
        ) VALUES (
        ${currentActor.schoolId}::uuid, ${scoreId}::uuid, ${oldMark}, ${mark},
        ${oldStatus}, ${item.status}, ${currentActor.membershipId}::uuid,
        ${approvalReason}, ${item.clientId}::uuid
        )
      `.execute(tx);
      await recordAudit(tx, {
        schoolId: currentActor.schoolId,
        userId: currentActor.userId,
        action: current ? "score.updated" : "score.created",
        resourceType: "score",
        resourceId: scoreId,
        reason: approvalReason,
        metadata: {
          clientId: item.clientId,
          enteredAt: item.enteredAt ?? null,
          version,
          approvedLockedTerm: assessment.term_status === "locked",
        },
      });
      hasAppliedWrite = true;
      outcomes.push({
        clientId: item.clientId,
        outcome: "applied",
        currentMark: mark,
        currentVersion: version,
      });
    }

    if (hasAppliedWrite && assessment.term_status === "locked") {
      await computeTermResults(tx, currentActor.schoolId, assessment.term_id);
    }
    const allRejectedByTermLock = outcomes.length > 0 && outcomes.every(
      (outcome) => outcome.outcome === "rejected" && outcome.reason === "TERM_LOCKED",
    );
    response.status(allRejectedByTermLock ? 409 : 200).json({ items: outcomes });
  }),
);

academicCoreRoutes.post(
  "/terms/:id/compute-results",
  asyncHandler(async (request, response) => {
    const termId = idSchema.safeParse(request.params.id);
    if (!termId.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", termId.error.issues);
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "results:compute");
    const term = await sql<{ status: string }>`
      SELECT status FROM terms
      WHERE school_id = ${currentActor.schoolId}::uuid AND id = ${termId.data}::uuid
    `.execute(tx);
    if (!term.rows[0]) throw new HttpError(404, "NOT_FOUND", "Term not found");
    if (term.rows[0].status === "locked") {
      throw new HttpError(409, "TERM_LOCKED", "Locked terms cannot be recomputed");
    }
    const computed = await computeTermResults(tx, currentActor.schoolId, termId.data);
    await recordAudit(tx, {
      schoolId: currentActor.schoolId,
      userId: currentActor.userId,
      action: "term.results_computed",
      resourceType: "term",
      resourceId: termId.data,
      metadata: computed,
    });
    response.json(computed);
  }),
);

academicCoreRoutes.post(
  "/terms/:id/lock",
  asyncHandler(async (request, response) => {
    const termId = idSchema.safeParse(request.params.id);
    if (!termId.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", termId.error.issues);
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "terms:lock");
    const current = await sql<{ status: string }>`
      SELECT status FROM terms
      WHERE school_id = ${currentActor.schoolId}::uuid AND id = ${termId.data}::uuid
      FOR UPDATE
    `.execute(tx);
    if (!current.rows[0]) throw new HttpError(404, "NOT_FOUND", "Term not found");
    if (current.rows[0].status === "locked") {
      response.json({ id: termId.data, status: "locked" });
      return;
    }
    const computed = await computeTermResults(tx, currentActor.schoolId, termId.data);
    await sql`UPDATE terms SET status = 'locked' WHERE id = ${termId.data}::uuid`.execute(tx);
    await recordAudit(tx, {
      schoolId: currentActor.schoolId,
      userId: currentActor.userId,
      action: "term.locked",
      resourceType: "term",
      resourceId: termId.data,
      metadata: computed,
    });
    response.json({ id: termId.data, status: "locked" });
  }),
);

academicCoreRoutes.get(
  "/results",
  asyncHandler(async (request, response) => {
    const filters = z.object({
      classId: idSchema.optional(),
      subjectId: idSchema.optional(),
      termId: idSchema.optional(),
      studentId: idSchema.optional(),
    }).strict().safeParse(request.query);
    if (!filters.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", filters.error.issues);
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "scores:read");
    if (filters.data.classId) {
      await requireScope(request as RequestWithTenant, "scores:read", {
        type: "class",
        id: filters.data.classId,
      }, true);
      if (filters.data.subjectId) {
        const broad = await can(currentActor, "academics:manage", tx)
          || await can(currentActor, "terms:lock", tx);
        const assigned = broad || (await sql<{ allowed: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM teacher_assignments ta
            JOIN academic_years ay
              ON ay.school_id = ta.school_id AND ay.id = ta.academic_year_id
            WHERE ta.school_id = ${currentActor.schoolId}::uuid
              AND ta.membership_id = ${currentActor.membershipId}::uuid
              AND ta.class_id = ${filters.data.classId}::uuid
              AND ta.academic_year_id = ay.id AND ay.status = 'open'
              AND ta.start_date <= CURRENT_DATE
              AND (ta.end_date IS NULL OR ta.end_date >= CURRENT_DATE)
              AND (ta.assignment_type IN ('class_teacher', 'all_subjects')
                OR (ta.assignment_type = 'subject' AND ta.subject_id = ${filters.data.subjectId}::uuid))
          ) AS allowed
        `.execute(tx)).rows[0]?.allowed === true;
        if (!assigned) throw new HttpError(404, "NOT_FOUND", "Resource not found");
      }
    } else if (filters.data.studentId) {
      await requireScope(request as RequestWithTenant, "scores:read", {
        type: "student_history",
        id: filters.data.studentId,
      }, true);
    } else {
      const broad = await can(currentActor, "academics:manage", tx)
        || await can(currentActor, "terms:lock", tx);
      if (!broad) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    }
    const rows = await sql`
      SELECT r.id, r.term_id AS "termId", r.class_id AS "classId",
        r.student_id AS "studentId", r.subject_id AS "subjectId",
        r.sba_raw AS "sbaRaw", r.sba_max AS "sbaMax",
        r.exam_raw AS "examRaw", r.exam_max AS "examMax",
        r.sba_scaled AS "sbaScaled", r.exam_scaled AS "examScaled",
        r.total, r.grades, r.subject_position AS "subjectPosition",
        r.status, r.incomplete_reason AS "incompleteReason",
        r.scheme_snapshot AS "schemeSnapshot", r.computed_at AS "computedAt"
      FROM term_results r
      WHERE r.school_id = ${currentActor.schoolId}::uuid
        AND (${filters.data.classId ?? null}::uuid IS NULL OR r.class_id = ${filters.data.classId ?? null}::uuid)
        AND (${filters.data.subjectId ?? null}::uuid IS NULL OR r.subject_id = ${filters.data.subjectId ?? null}::uuid)
        AND (${filters.data.termId ?? null}::uuid IS NULL OR r.term_id = ${filters.data.termId ?? null}::uuid)
        AND (${filters.data.studentId ?? null}::uuid IS NULL OR r.student_id = ${filters.data.studentId ?? null}::uuid)
        AND (
          EXISTS (
            SELECT 1 FROM membership_roles mr
            JOIN role_permissions rp ON rp.school_id = mr.school_id AND rp.role_id = mr.role_id
            WHERE mr.school_id = r.school_id AND mr.membership_id = ${currentActor.membershipId}::uuid
              AND rp.permission IN ('academics:manage', 'terms:lock')
          )
          OR EXISTS (
            SELECT 1 FROM teacher_assignments ta
            JOIN academic_years ay ON ay.school_id = ta.school_id AND ay.id = ta.academic_year_id
            WHERE ta.school_id = r.school_id
              AND ta.membership_id = ${currentActor.membershipId}::uuid
              AND ta.class_id = r.class_id
              AND ay.status = 'open'
              AND ta.start_date <= CURRENT_DATE
              AND (ta.end_date IS NULL OR ta.end_date >= CURRENT_DATE)
              AND EXISTS (
                SELECT 1 FROM enrollments e
                WHERE e.school_id = ta.school_id AND e.student_id = r.student_id
                  AND e.class_id = ta.class_id AND e.academic_year_id = ta.academic_year_id
                  AND e.status = 'active'
              )
              AND (
                ta.assignment_type IN ('class_teacher', 'all_subjects')
                OR (ta.assignment_type = 'subject' AND ta.subject_id = r.subject_id)
              )
          )
        )
      ORDER BY r.class_id, r.subject_id, r.student_id
      LIMIT 5000
    `.execute(tx);
    response.json({ items: rows.rows });
  }),
);

academicCoreRoutes.get(
  "/terms/:id/report-cards",
  asyncHandler(async (request, response) => {
    const termId = idSchema.safeParse(request.params.id);
    const query = z.object({
      classId: idSchema.optional(),
      studentIds: z.string().max(8000).optional(),
    }).strict().safeParse(request.query);
    if (!termId.success || !query.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", [
        ...(!termId.success ? termId.error.issues : []),
        ...(!query.success ? query.error.issues : []),
      ]);
    }
    const studentIds = query.data.studentIds?.split(",").filter(Boolean);
    if (studentIds && (studentIds.length > 500 || studentIds.some((id) => !idSchema.safeParse(id).success))) {
      throw new HttpError(400, "VALIDATION_ERROR", "Invalid studentIds filter");
    }
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "reports:read");
    const term = await sql<{
      id: string;
      name: string;
      start_date: string;
      end_date: string;
      vacation_date: string | null;
      next_term_begins: string | null;
      academic_year_id: string;
    }>`
      SELECT id, name, start_date::text, end_date::text, vacation_date::text,
        next_term_begins::text, academic_year_id
      FROM terms WHERE school_id = ${currentActor.schoolId}::uuid AND id = ${termId.data}::uuid
    `.execute(tx);
    if (!term.rows[0]) throw new HttpError(404, "NOT_FOUND", "Term not found");
    const reportScaleKinds = await sql<{ report_scale_kinds: { primary?: string[]; jhs?: string[] } }>`
      SELECT report_scale_kinds FROM school_settings WHERE school_id = ${currentActor.schoolId}::uuid
    `.execute(tx);
    const school = await sql`
      SELECT name, address, phone, email, region, district_directorate AS "districtDirectorate",
        headteacher_name AS "headteacherName"
      FROM schools WHERE id = ${currentActor.schoolId}::uuid
    `.execute(tx);
    const summaries = await sql<{
      student_id: string;
      class_id: string;
      class_name: string;
      level: number;
      student_name: string;
      roll_number: number;
      results_complete: number;
      total_raw: number;
      out_of: number;
      average: number | null;
      aggregate: number | null;
      overall_position: number | null;
      subjects_passed: number;
      subjects_failed: number;
      class_enrolment: number;
      overall_comment: string | null;
      days_present: number | null;
      days_open: number | null;
      aggregate_subjects: Array<{ subjectId: string; subjectName: string; total: number }> | null;
    }>`
      SELECT ts.student_id, ts.class_id, c.name AS class_name, c.level,
        concat_ws(' ', st.first_name, st.other_names, st.last_name) AS student_name,
        e.roll_number, ts.results_complete, ts.total_raw, ts.out_of, ts.average,
        ts.aggregate, ts.overall_position, ts.subjects_passed, ts.subjects_failed,
        ts.class_enrolment, ts.overall_comment, ta.days_present, ta.days_open,
        ts.scheme_snapshot -> 'aggregateSubjects' AS aggregate_subjects
      FROM term_summaries ts
      JOIN students st ON st.school_id = ts.school_id AND st.id = ts.student_id
      JOIN classes c ON c.school_id = ts.school_id AND c.id = ts.class_id
      JOIN enrollments e
        ON e.school_id = ts.school_id AND e.student_id = ts.student_id
        AND e.class_id = ts.class_id AND e.academic_year_id = ts.academic_year_id
      LEFT JOIN term_attendance ta
        ON ta.school_id = ts.school_id AND ta.student_id = ts.student_id AND ta.term_id = ts.term_id
      WHERE ts.school_id = ${currentActor.schoolId}::uuid
        AND ts.term_id = ${termId.data}::uuid
        AND (${query.data.classId ?? null}::uuid IS NULL OR ts.class_id = ${query.data.classId ?? null}::uuid)
        AND (${studentIds ?? null}::uuid[] IS NULL OR ts.student_id = ANY(${studentIds ?? []}::uuid[]))
        AND e.status = 'active'
      ORDER BY c.name, e.roll_number, st.last_name, st.first_name
    `.execute(tx);
    if (summaries.rows.length === 0) {
      throw new HttpError(409, "RESULTS_NOT_COMPUTED", "Results must be computed before report cards are available");
    }
    const items = [];
    for (const summary of summaries.rows) {
      const subjects = await sql<{
        id: string;
        name: string;
        sba_scaled: number | null;
        exam_scaled: number | null;
        total: number | null;
        subject_position: number | null;
        grades: Record<string, string>;
      }>`
        SELECT s.id, s.name, r.sba_scaled, r.exam_scaled, r.total, r.subject_position, r.grades
        FROM term_results r
        JOIN subjects s ON s.school_id = r.school_id AND s.id = r.subject_id
        WHERE r.school_id = ${currentActor.schoolId}::uuid
          AND r.term_id = ${termId.data}::uuid
          AND r.class_id = ${summary.class_id}::uuid
          AND r.student_id = ${summary.student_id}::uuid
        ORDER BY s.name
      `.execute(tx);
      const scaleKinds = summary.level <= 6
        ? reportScaleKinds.rows[0]?.report_scale_kinds.primary ?? ["letter", "proficiency"]
        : reportScaleKinds.rows[0]?.report_scale_kinds.jhs ?? ["number"];
      items.push({
        school: school.rows[0],
        term: {
          name: term.rows[0]!.name,
          vacationDate: term.rows[0]!.vacation_date,
          nextTermBegins: term.rows[0]!.next_term_begins,
        },
        className: summary.class_name,
        rollNumber: summary.roll_number,
        studentName: summary.student_name,
        aggregateSubjects: summary.aggregate_subjects ?? [],
        subjects: subjects.rows.map((subject) => ({
          subjectId: subject.id,
          name: subject.name,
          sbaScaled: subject.sba_scaled,
          examScaled: subject.exam_scaled,
          total: subject.total,
          position: ordinalLabel(subject.subject_position),
          countedTowardAggregate: (summary.aggregate_subjects ?? []).some(
            (aggregateSubject) => aggregateSubject.subjectId === subject.id,
          ),
          grades: Object.fromEntries(
            Object.entries(subject.grades).filter(([kind]) => scaleKinds.includes(kind)),
          ),
        })),
        totalRawScore: summary.total_raw,
        outOf: summary.out_of,
        average: summary.average,
        aggregate: summary.aggregate,
        subjectsPassed: summary.subjects_passed,
        subjectsFailed: summary.subjects_failed,
        classEnrolment: summary.class_enrolment,
        overallPosition: ordinalLabel(summary.overall_position),
        attendance: { present: summary.days_present ?? 0, open: summary.days_open ?? 0 },
        overallComment: summary.overall_comment,
      });
    }
    response.json({ items });
  }),
);

academicCoreRoutes.get(
  "/classes/:id/broadsheet",
  asyncHandler(async (request, response) => {
    const classId = idSchema.safeParse(request.params.id);
    const termId = idSchema.safeParse(request.query.termId);
    if (!classId.success || !termId.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", [
        ...(!classId.success ? classId.error.issues : []),
        ...(!termId.success ? termId.error.issues : []),
      ]);
    }
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "reports:read");
    await requireScope(request as RequestWithTenant, "reports:read", {
      type: "class",
      id: classId.data,
    }, true);
    const classResult = await sql<{ name: string; academic_year_id: string }>`
      SELECT name, academic_year_id FROM classes WHERE school_id = ${currentActor.schoolId}::uuid
        AND id = ${classId.data}::uuid
    `.execute(tx);
    if (!classResult.rows[0]) throw new HttpError(404, "NOT_FOUND", "Class not found");
    const termResult = await sql<{ academic_year_id: string }>`
      SELECT academic_year_id FROM terms
      WHERE school_id = ${currentActor.schoolId}::uuid AND id = ${termId.data}::uuid
    `.execute(tx);
    if (!termResult.rows[0] || termResult.rows[0].academic_year_id !== classResult.rows[0].academic_year_id) {
      throw new HttpError(404, "NOT_FOUND", "Term not found");
    }
    const subjects = await sql<{ id: string; name: string }>`
      SELECT s.id, s.name
      FROM class_subjects cs
      JOIN subjects s ON s.school_id = cs.school_id AND s.id = cs.subject_id
      WHERE cs.school_id = ${currentActor.schoolId}::uuid
        AND cs.class_id = ${classId.data}::uuid
      ORDER BY s.name
    `.execute(tx);
    const pupils = await sql<{
      student_id: string;
      roll_number: number;
      name: string;
      total: number | null;
      aggregate: number | null;
      overall_position: number | null;
      aggregate_subjects: Array<{ subjectId: string; subjectName: string; total: number }> | null;
    }>`
      SELECT e.student_id, e.roll_number,
        concat_ws(' ', st.first_name, st.other_names, st.last_name) AS name,
        ts.total_raw AS total, ts.aggregate, ts.overall_position,
        ts.scheme_snapshot -> 'aggregateSubjects' AS aggregate_subjects
      FROM enrollments e
      JOIN students st ON st.school_id = e.school_id AND st.id = e.student_id
      LEFT JOIN term_summaries ts
        ON ts.school_id = e.school_id AND ts.student_id = e.student_id
        AND ts.class_id = e.class_id AND ts.term_id = ${termId.data}::uuid
      WHERE e.school_id = ${currentActor.schoolId}::uuid
        AND e.class_id = ${classId.data}::uuid
        AND e.academic_year_id = ${termResult.rows[0].academic_year_id}::uuid
        AND e.status = 'active'
      ORDER BY e.roll_number
    `.execute(tx);
    if (!pupils.rows.some((pupil) => pupil.aggregate !== null)) {
      throw new HttpError(409, "RESULTS_NOT_COMPUTED", "Results must be computed before the broadsheet is available");
    }
    const rows = [];
    for (const pupil of pupils.rows) {
      const totals = await sql<{ subject_id: string; total: number | null }>`
        SELECT subject_id, total FROM term_results
        WHERE school_id = ${currentActor.schoolId}::uuid
          AND term_id = ${termId.data}::uuid AND class_id = ${classId.data}::uuid
          AND student_id = ${pupil.student_id}::uuid
      `.execute(tx);
      rows.push({
        rollNumber: pupil.roll_number,
        name: pupil.name,
        aggregateSubjects: pupil.aggregate_subjects ?? [],
        subjects: subjects.rows.map((subject) => ({
          subjectId: subject.id,
          name: subject.name,
          total: totals.rows.find((row) => row.subject_id === subject.id)?.total ?? null,
          countedTowardAggregate: (pupil.aggregate_subjects ?? []).some(
            (aggregateSubject) => aggregateSubject.subjectId === subject.id,
          ),
        })),
        total: pupil.total,
        aggregate: pupil.aggregate,
        overallPosition: ordinalLabel(pupil.overall_position),
      });
    }
    response.json({ className: classResult.rows[0].name, termId: termId.data, items: rows });
  }),
);

academicCoreRoutes.get(
  "/classes/:id/assessments",
  asyncHandler(async (request, response) => {
    const classId = idSchema.safeParse(request.params.id);
    if (!classId.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", classId.error.issues);
    }
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "scores:read", {
      type: "class",
      id: classId.data,
    }, true);
    const classroom = await sql<{ id: string; name: string; academic_year_id: string }>`
      SELECT id, name, academic_year_id FROM classes
      WHERE school_id = ${currentActor.schoolId}::uuid
        AND id = ${classId.data}::uuid
    `.execute(tx);
    if (!classroom.rows[0]) throw new HttpError(404, "NOT_FOUND", "Class not found");

    const term = await sql<{ id: string; name: string }>`
      SELECT id, name FROM terms
      WHERE school_id = ${currentActor.schoolId}::uuid
        AND academic_year_id = ${classroom.rows[0].academic_year_id}::uuid
        AND status = 'open'
      ORDER BY (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC
      LIMIT 1
    `.execute(tx);
    const assessmentRows = term.rows[0]
      ? await sql<{
          id: string;
          subject_id: string;
          subject_name: string;
          name: string;
          kind: string;
          max_mark: string;
          component: string | null;
        }>`
          SELECT a.id, a.subject_id, s.name AS subject_name, a.name, a.kind,
            a.max_mark::text AS max_mark, sc.kind AS component
          FROM assessments a
          JOIN subjects s ON s.school_id = a.school_id AND s.id = a.subject_id
          LEFT JOIN scheme_components sc
            ON sc.school_id = a.school_id AND sc.id = a.scheme_component_id
          WHERE a.school_id = ${currentActor.schoolId}::uuid
            AND a.class_id = ${classId.data}::uuid
            AND a.term_id = ${term.rows[0].id}::uuid
            AND ${assessmentScopePredicate(currentActor.membershipId)}
          ORDER BY s.name, sc.sort_order, a.name
        `.execute(tx)
      : { rows: [] as Array<{
          id: string;
          subject_id: string;
          subject_name: string;
          name: string;
          kind: string;
          max_mark: string;
          component: string | null;
        }> };
    response.json({
      class: {
        id: classroom.rows[0].id,
        name: classroom.rows[0].name,
      },
      term: term.rows[0] ?? null,
      items: assessmentRows.rows.map((item) => ({
        id: item.id,
        subjectId: item.subject_id,
        subjectName: item.subject_name,
        name: item.name,
        kind: item.kind,
        maxMark: item.max_mark,
        component: item.component,
      })),
    });
  }),
);

academicCoreRoutes.get(
  "/sync/bootstrap",
  asyncHandler(async (request, response) => {
    const query = z.object({ classId: idSchema }).strict().safeParse(request.query);
    if (!query.success) throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", query.error.issues);
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "scores:read", {
      type: "class",
      id: query.data.classId,
    }, true);
    const classResult = await sql<{ id: string; academic_year_id: string; name: string }>`
      SELECT id, academic_year_id, name FROM classes
      WHERE school_id = ${currentActor.schoolId}::uuid AND id = ${query.data.classId}::uuid
    `.execute(tx);
    const classroom = classResult.rows[0];
    if (!classroom) throw new HttpError(404, "NOT_FOUND", "Class not found");
    const termResult = await sql<{ id: string; name: string }>`
      SELECT id, name FROM terms
      WHERE school_id = ${currentActor.schoolId}::uuid
        AND academic_year_id = ${classroom.academic_year_id}::uuid
        AND status = 'open'
      ORDER BY (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC
      LIMIT 1
    `.execute(tx);
    const term = termResult.rows[0];
    const roster = await sql`
      SELECT s.id, e.roll_number AS "rollNumber",
        concat_ws(' ', s.first_name, s.other_names, s.last_name) AS name
      FROM enrollments e
      JOIN students s ON s.school_id = e.school_id AND s.id = e.student_id
      WHERE e.school_id = ${currentActor.schoolId}::uuid
        AND e.class_id = ${classroom.id}::uuid
        AND e.academic_year_id = ${classroom.academic_year_id}::uuid
        AND e.status = 'active'
      ORDER BY e.roll_number
    `.execute(tx);

    let assessments: Record<string, unknown>[] = [];
    let scores: Record<string, unknown>[] = [];
    if (term) {
      const assessmentRows = await sql<{
        id: string;
        subject_id: string;
        subject_name: string;
        name: string;
        kind: string;
        max_mark: string;
        component_kind: string;
      }>`
        SELECT a.id, a.subject_id, s.name AS subject_name, a.name, a.kind,
          a.max_mark::text AS max_mark, sc.kind AS component_kind
        FROM assessments a
        JOIN subjects s ON s.school_id = a.school_id AND s.id = a.subject_id
        LEFT JOIN scheme_components sc
          ON sc.school_id = a.school_id AND sc.id = a.scheme_component_id
        WHERE a.school_id = ${currentActor.schoolId}::uuid
          AND a.class_id = ${classroom.id}::uuid AND a.term_id = ${term.id}::uuid
          AND ${assessmentScopePredicate(currentActor.membershipId)}
        ORDER BY s.name, a.name
      `.execute(tx);
      assessments = assessmentRows.rows.map((item) => ({
        id: item.id,
        subjectId: item.subject_id,
        subjectName: item.subject_name,
        name: item.name,
        kind: item.kind,
        component: item.component_kind,
        maxMark: item.max_mark,
      }));
      const scoreRows = await sql<{
        assessmentId: string;
        studentId: string;
        mark: string | null;
        status: string;
        version: number;
        clientId: string | null;
      }>`
        SELECT scores.assessment_id AS "assessmentId", scores.student_id AS "studentId",
          scores.mark, scores.status, scores.version, scores.client_id AS "clientId"
        FROM scores
        JOIN assessments a ON a.school_id = scores.school_id AND a.id = scores.assessment_id
        WHERE scores.school_id = ${currentActor.schoolId}::uuid
          AND a.class_id = ${classroom.id}::uuid AND a.term_id = ${term.id}::uuid
          AND ${assessmentScopePredicate(currentActor.membershipId)}
        ORDER BY scores.student_id
      `.execute(tx);
      scores = scoreRows.rows;
    }

    const canReadAttendance = await can(currentActor, "attendance:read", tx, {
      type: "class",
      id: classroom.id,
    });
    let recentRegisters: unknown[] = [];
    if (canReadAttendance) {
      const registers = await sql`
          SELECT id, register_date AS date, status, submitted_at AS "submittedAt"
          FROM attendance_registers
          WHERE school_id = ${currentActor.schoolId}::uuid
            AND class_id = ${classroom.id}::uuid
          ORDER BY register_date DESC LIMIT 20
        `.execute(tx);
      recentRegisters = registers.rows;
    } else {
      await recordAudit(tx, {
        schoolId: currentActor.schoolId,
        userId: currentActor.userId,
        action: "authorization.denied",
        resourceType: "class",
        resourceId: classroom.id,
        metadata: { permission: "attendance:read" },
      });
    }
    response.json({
      class: { id: classroom.id, name: classroom.name },
      openTerm: term ? { id: term.id, name: term.name } : null,
      roster: roster.rows,
      assessments,
      scores,
      recentRegisters,
    });
  }),
);

academicCoreRoutes.get(
  "/terms/:id/readiness",
  asyncHandler(async (request, response) => {
    const termId = idSchema.safeParse(request.params.id);
    const filters = z.object({ classId: idSchema.optional() }).strict().safeParse(request.query);
    if (!termId.success || !filters.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", [
        ...(!termId.success ? termId.error.issues : []),
        ...(!filters.success ? filters.error.issues : []),
      ]);
    }
    const currentActor = actor(request as RequestWithTenant);
    const { tx } = context(request as RequestWithTenant);
    await requireScope(request as RequestWithTenant, "results:compute");
    const termResult = await sql<{
      id: string;
      academic_year_id: string;
      start_date: string;
      end_date: string;
    }>`
      SELECT id, academic_year_id, start_date::text, end_date::text
      FROM terms WHERE school_id = ${currentActor.schoolId}::uuid AND id = ${termId.data}::uuid
    `.execute(tx);
    const term = termResult.rows[0];
    if (!term) throw new HttpError(404, "NOT_FOUND", "Term not found");
    if (filters.data.classId) {
      const target = await sql`SELECT id FROM classes
        WHERE school_id = ${currentActor.schoolId}::uuid
          AND id = ${filters.data.classId}::uuid
          AND academic_year_id = ${term.academic_year_id}::uuid`.execute(tx);
      if (!target.rows[0]) throw new HttpError(404, "NOT_FOUND", "Class not found");
    }
    const settings = await sql<{ sba_exam_gap_threshold: number }>`
      SELECT sba_exam_gap_threshold FROM school_settings
      WHERE school_id = ${currentActor.schoolId}::uuid
    `.execute(tx);
    if (!settings.rows[0]) throw new Error("School settings are missing");

    const classRows = await sql<{ id: string; name: string }>`
      SELECT id, name FROM classes
      WHERE school_id = ${currentActor.schoolId}::uuid
        AND academic_year_id = ${term.academic_year_id}::uuid
        AND (${filters.data.classId ?? null}::uuid IS NULL OR id = ${filters.data.classId ?? null}::uuid)
      ORDER BY name
    `.execute(tx);
    const output = [];
    for (const classroom of classRows.rows) {
      const missing = await sql`
        SELECT cs.subject_id AS "subjectId", sub.name AS "subjectName",
          component.id AS "componentId", component.name AS "componentName",
          count(DISTINCT e.student_id)::integer AS expected,
          count(DISTINCT score.student_id)::integer AS entered,
          coalesce(array_agg(DISTINCT coalesce(u.email, u.phone))
            FILTER (WHERE ta.membership_id IS NOT NULL), '{}') AS "assignedTeachers"
        FROM class_subjects cs
        JOIN subjects sub ON sub.school_id = cs.school_id AND sub.id = cs.subject_id
        JOIN LATERAL (
          SELECT gs.id FROM grading_schemes gs
          WHERE gs.school_id = cs.school_id AND gs.is_default
            AND (SELECT level FROM classes WHERE id = cs.class_id)
              BETWEEN gs.level_from AND gs.level_to
          ORDER BY CASE WHEN gs.name IN ('Primary scheme', 'JHS scheme') THEN 0 ELSE 1 END,
            gs.created_at DESC
          LIMIT 1
        ) scheme ON TRUE
        JOIN scheme_components component
          ON component.school_id = cs.school_id AND component.scheme_id = scheme.id AND component.is_active
        LEFT JOIN assessments a
          ON a.school_id = cs.school_id AND a.class_id = cs.class_id
          AND a.subject_id = cs.subject_id AND a.term_id = ${term.id}::uuid
          AND a.scheme_component_id = component.id
        LEFT JOIN enrollments e
          ON e.school_id = cs.school_id AND e.class_id = cs.class_id AND e.status = 'active'
          AND e.academic_year_id = ${term.academic_year_id}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM student_subject_opt_outs o
            WHERE o.school_id = cs.school_id AND o.student_id = e.student_id
              AND o.class_subject_id = cs.id
          )
        LEFT JOIN scores score
          ON score.school_id = a.school_id AND score.assessment_id = a.id
          AND score.student_id = e.student_id
        LEFT JOIN teacher_assignments ta
          ON ta.school_id = cs.school_id AND ta.class_id = cs.class_id
          AND ta.academic_year_id = ${term.academic_year_id}::uuid
          AND ta.start_date <= CURRENT_DATE
          AND (ta.end_date IS NULL OR ta.end_date >= CURRENT_DATE)
          AND (
            (ta.assignment_type = 'subject' AND ta.subject_id = cs.subject_id)
            OR ta.assignment_type = 'all_subjects'
          )
        LEFT JOIN memberships m ON m.school_id = ta.school_id AND m.id = ta.membership_id
        LEFT JOIN users u ON u.id = m.user_id
        WHERE cs.school_id = ${currentActor.schoolId}::uuid
          AND cs.class_id = ${classroom.id}::uuid
        GROUP BY cs.subject_id, sub.name, component.id, component.name
        HAVING count(DISTINCT score.student_id) < count(DISTINCT e.student_id)
        ORDER BY sub.name, component.name
      `.execute(tx);

      const missingRegisters = await sql<{ date: string }>`
        SELECT days.day::date::text AS date
        FROM generate_series(
          ${term.start_date}::date,
          LEAST(${term.end_date}::date, CURRENT_DATE),
          interval '1 day'
        ) AS days(day)
        WHERE extract(isodow FROM days.day) BETWEEN 1 AND 5
          AND NOT EXISTS (
            SELECT 1 FROM attendance_registers r
            WHERE r.school_id = ${currentActor.schoolId}::uuid
              AND r.class_id = ${classroom.id}::uuid
              AND r.register_date = days.day::date
              AND r.status = 'submitted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM school_closures closure
            WHERE closure.school_id = ${currentActor.schoolId}::uuid
              AND days.day::date BETWEEN closure.start_date AND closure.end_date
          )
        ORDER BY days.day
      `.execute(tx);

      const identicalMarks = await sql`
        SELECT sc1.name AS "componentName", s1.name AS "firstSubject",
          s2.name AS "secondSubject", count(*)::integer AS "pupilCount",
          count(*) FILTER (WHERE score1.status = score2.status AND score1.mark = score2.mark)::integer AS "matchingCount"
        FROM assessments a1
        JOIN scheme_components sc1
          ON sc1.school_id = a1.school_id AND sc1.id = a1.scheme_component_id
        JOIN assessments a2
          ON a2.school_id = a1.school_id AND a2.term_id = a1.term_id
          AND a2.class_id = a1.class_id AND a2.id > a1.id
        JOIN scheme_components sc2
          ON sc2.school_id = a2.school_id AND sc2.id = a2.scheme_component_id
          AND sc2.name = sc1.name AND sc2.kind = sc1.kind
        JOIN subjects s1 ON s1.school_id = a1.school_id AND s1.id = a1.subject_id
        JOIN subjects s2 ON s2.school_id = a2.school_id AND s2.id = a2.subject_id
        JOIN scores score1 ON score1.school_id = a1.school_id AND score1.assessment_id = a1.id
        JOIN scores score2 ON score2.school_id = a2.school_id
          AND score2.assessment_id = a2.id AND score2.student_id = score1.student_id
        JOIN enrollments e ON e.school_id = score1.school_id
          AND e.student_id = score1.student_id AND e.class_id = a1.class_id
          AND e.academic_year_id = ${term.academic_year_id}::uuid AND e.status = 'active'
        WHERE a1.school_id = ${currentActor.schoolId}::uuid
          AND a1.term_id = ${term.id}::uuid AND a1.class_id = ${classroom.id}::uuid
          AND score1.status = 'scored' AND score2.status = 'scored'
        GROUP BY sc1.name, s1.name, s2.name
        HAVING count(*) >= 10
          AND count(*) FILTER (WHERE score1.mark = score2.mark)::numeric / count(*) >= 0.9
        ORDER BY sc1.name, s1.name, s2.name
      `.execute(tx);

      const gaps = await sql`
        SELECT r.student_id AS "studentId", concat_ws(' ', st.first_name, st.other_names, st.last_name) AS "studentName",
          s.name AS "subjectName",
          abs(round(r.sba_raw / nullif(r.sba_max, 0) * 100, 1)
            - round(r.exam_raw / nullif(r.exam_max, 0) * 100, 1)) AS "percentageGap"
        FROM term_results r
        JOIN students st ON st.school_id = r.school_id AND st.id = r.student_id
        JOIN subjects s ON s.school_id = r.school_id AND s.id = r.subject_id
        WHERE r.school_id = ${currentActor.schoolId}::uuid
          AND r.term_id = ${term.id}::uuid AND r.class_id = ${classroom.id}::uuid
          AND r.sba_raw IS NOT NULL AND r.sba_max > 0
          AND r.exam_raw IS NOT NULL AND r.exam_max > 0
          AND abs(round(r.sba_raw / nullif(r.sba_max, 0) * 100, 1)
            - round(r.exam_raw / nullif(r.exam_max, 0) * 100, 1)) >= ${settings.rows[0].sba_exam_gap_threshold}
        ORDER BY "percentageGap" DESC, "studentName"
      `.execute(tx);

      const unrankable = await sql`
        SELECT ts.student_id AS "studentId",
          concat_ws(' ', st.first_name, st.other_names, st.last_name) AS "studentName",
          e.roll_number AS "rollNumber"
        FROM term_summaries ts
        JOIN students st ON st.school_id = ts.school_id AND st.id = ts.student_id
        JOIN enrollments e ON e.school_id = ts.school_id AND e.student_id = ts.student_id
          AND e.class_id = ts.class_id AND e.academic_year_id = ts.academic_year_id
          AND e.status = 'active'
        WHERE ts.school_id = ${currentActor.schoolId}::uuid
          AND ts.term_id = ${term.id}::uuid AND ts.class_id = ${classroom.id}::uuid
          AND ts.aggregate IS NULL
        ORDER BY e.roll_number
      `.execute(tx);
      const ready = missing.rows.length === 0 &&
        missingRegisters.rows.length === 0 && unrankable.rows.length === 0;
      output.push({
        classId: classroom.id,
        className: classroom.name,
        missingMarks: missing.rows,
        missingRegisters: missingRegisters.rows,
        identicalMarks: identicalMarks.rows,
        sbaExamGaps: gaps.rows,
        unrankablePupils: unrankable.rows,
        ready,
      });
    }
    response.json({ termId: term.id, classes: output });
  }),
);
