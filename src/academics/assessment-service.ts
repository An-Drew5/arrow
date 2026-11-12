import { sql, type Transaction } from "kysely";
import type { Database } from "../shared/db/database";

export async function ensureTermAssessments(
  tx: Transaction<Database>,
  termId: string,
): Promise<void> {
  await sql`
    INSERT INTO assessments (
      school_id, academic_year_id, class_id, subject_id, term_id,
      scheme_component_id, name, kind, max_mark, component
    )
    SELECT
      t.school_id,
      t.academic_year_id,
      c.id,
      cs.subject_id,
      t.id,
      component.id,
      component.name,
      CASE
        WHEN component.kind = 'exam' THEN 'exam'
        WHEN component.name ILIKE '%test%' THEN 'class_test'
        WHEN component.name ILIKE '%project%' THEN 'project'
        ELSE 'assignment'
      END,
      component.max_mark,
      CASE WHEN component.kind = 'exam' THEN 'exam' ELSE 'class_score' END
    FROM terms t
    JOIN classes c
      ON c.school_id = t.school_id AND c.academic_year_id = t.academic_year_id
    JOIN class_subjects cs
      ON cs.school_id = c.school_id AND cs.class_id = c.id
    JOIN LATERAL (
      SELECT gs.id, gs.school_id
      FROM grading_schemes gs
      WHERE gs.school_id = c.school_id
        AND gs.is_default
        AND c.level BETWEEN gs.level_from AND gs.level_to
      ORDER BY
        CASE WHEN gs.name IN ('Primary scheme', 'JHS scheme') THEN 0 ELSE 1 END,
        gs.created_at DESC
      LIMIT 1
    ) scheme ON TRUE
    JOIN LATERAL (
      SELECT sc.id, sc.name, sc.kind, sc.max_mark
      FROM scheme_components sc
      WHERE sc.school_id = scheme.school_id AND sc.scheme_id = scheme.id AND sc.is_active
    ) component ON TRUE
    WHERE t.id = ${termId}::uuid
      AND t.status = 'open'
    ORDER BY c.id, cs.subject_id, component.id
    ON CONFLICT (
      school_id, term_id, class_id, subject_id, scheme_component_id
    ) WHERE scheme_component_id IS NOT NULL DO NOTHING
  `.execute(tx);
}

export async function ensureClassSubjectAssessments(
  tx: Transaction<Database>,
  classSubjectId: string,
): Promise<void> {
  const terms = await sql<{ id: string }>`
    SELECT t.id
    FROM class_subjects cs
    JOIN classes c ON c.school_id = cs.school_id AND c.id = cs.class_id
    JOIN terms t
      ON t.school_id = c.school_id
      AND t.academic_year_id = c.academic_year_id
      AND t.status = 'open'
    WHERE cs.id = ${classSubjectId}::uuid
    ORDER BY t.term_number
  `.execute(tx);
  for (const term of terms.rows) {
    await ensureTermAssessments(tx, term.id);
  }
}
