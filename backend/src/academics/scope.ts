import { sql, type Transaction } from "kysely";
import type { Actor, ResourceReference, ResourceScopeRule } from "../shared/rbac/can";
import type { Permission } from "../shared/rbac/permissions";
import type { Database } from "../shared/db/database";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function hasBroadReadCapability(
  actor: Actor,
  tx: Transaction<Database>,
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM membership_roles mr
      JOIN role_permissions rp
        ON rp.school_id = mr.school_id AND rp.role_id = mr.role_id
      WHERE mr.school_id = ${actor.schoolId}::uuid
        AND mr.membership_id = ${actor.membershipId}::uuid
        AND rp.permission IN ('academics:manage', 'terms:lock')
    ) AS allowed
  `.execute(tx);
  return result.rows[0]?.allowed === true;
}

async function hasStudentWriteCapability(
  actor: Actor,
  tx: Transaction<Database>,
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM membership_roles mr
      JOIN role_permissions rp
        ON rp.school_id = mr.school_id AND rp.role_id = mr.role_id
      WHERE mr.school_id = ${actor.schoolId}::uuid
        AND mr.membership_id = ${actor.membershipId}::uuid
        AND rp.permission = 'students:write'
    ) AS allowed
  `.execute(tx);
  return result.rows[0]?.allowed === true;
}

async function hasActiveAssignment(
  actor: Actor,
  tx: Transaction<Database>,
  where: ReturnType<typeof sql>,
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM teacher_assignments ta
      JOIN academic_years ay
        ON ay.school_id = ta.school_id AND ay.id = ta.academic_year_id
      WHERE ta.school_id = ${actor.schoolId}::uuid
        AND ta.membership_id = ${actor.membershipId}::uuid
        AND ay.status = 'open'
        AND ta.start_date <= CURRENT_DATE
        AND (ta.end_date IS NULL OR ta.end_date >= CURRENT_DATE)
        AND (${where})
    ) AS allowed
  `.execute(tx);
  return result.rows[0]?.allowed === true;
}

export const academicResourceScope: ResourceScopeRule = async (
  actor,
  permission,
  resource: ResourceReference,
  tx,
) => {
  if (!uuidPattern.test(resource.id)) return false;
  if (await hasBroadReadCapability(actor, tx)) return true;

  if (resource.type === "student_directory") {
    return hasStudentWriteCapability(actor, tx);
  }

  if (resource.type === "student_pii" || resource.type === "student") {
    if (await hasStudentWriteCapability(actor, tx)) return true;
    if (resource.type === "student_pii") return false;
  }

  if (resource.type === "class") {
    if (permission === "attendance:read" && await hasStudentWriteCapability(actor, tx)) {
      return true;
    }
    const assignmentCondition = permission === "attendance:write" || permission === "attendance:read"
      ? sql`ta.assignment_type IN ('class_teacher', 'all_subjects')`
      : sql`TRUE`;
    return hasActiveAssignment(
      actor,
      tx,
      sql`ta.class_id = ${resource.id}::uuid AND ${assignmentCondition}`,
    );
  }

  if (resource.type === "assessment") {
    const subjectCondition = permission === "scores:write"
      ? sql`(
          (ta.assignment_type = 'subject' AND ta.subject_id = a.subject_id)
          OR ta.assignment_type = 'all_subjects'
        )`
      : sql`(
          (ta.assignment_type = 'subject' AND ta.subject_id = a.subject_id)
          OR ta.assignment_type IN ('class_teacher', 'all_subjects')
        )`;
    return hasActiveAssignment(
      actor,
      tx,
      sql`EXISTS (
        SELECT 1 FROM assessments a
        WHERE a.id = ${resource.id}::uuid
          AND a.school_id = ta.school_id
          AND a.academic_year_id = ta.academic_year_id
          AND a.class_id = ta.class_id
          AND ${subjectCondition}
      )`,
    );
  }

  if (resource.type === "student" || resource.type === "student_history") {
    return hasActiveAssignment(
      actor,
      tx,
      sql`EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.school_id = ta.school_id
          AND e.student_id = ${resource.id}::uuid
          AND e.class_id = ta.class_id
          AND e.academic_year_id = ta.academic_year_id
          AND e.status = 'active'
          AND ta.assignment_type IN ('subject', 'class_teacher', 'all_subjects')
      )`,
    );
  }

  return false;
};