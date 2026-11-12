import { sql, type Transaction } from "kysely";
import type { Database } from "../shared/db/database";
import {
  calculateResult,
  competitionRanks,
  lookupGrade,
  resolveWeights,
  summarizePupil,
  type AssessmentScore,
  type GradingScale,
} from "./computation";

type Numeric = number | string;

interface TermRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface SettingsRow {
  position_basis: "best_n" | "all_subjects";
  aggregate_subject_count: number;
  pass_mark: number;
  late_counts_as_present: boolean;
}

interface ClassSubjectRow {
  class_id: string;
  class_name: string;
  level: number;
  subject_id: string;
  subject_name: string;
}

interface EnrolleeRow {
  student_id: string;
  class_id: string;
  roll_number: number;
}

function bandRecord(
  bands: readonly {
    min_score: number;
    max_score: number;
    label: string;
    points: Numeric | null;
    descriptor: string | null;
    is_credit: boolean;
    is_pass: boolean;
  }[],
) {
  return bands.map((band) => ({
    minScore: Number(band.min_score),
    maxScore: Number(band.max_score),
    label: band.label,
    points: band.points === null ? null : Number(band.points),
    descriptor: band.descriptor,
    isCredit: band.is_credit,
    isPass: band.is_pass,
  }));
}

export async function computeTermResults(
  tx: Transaction<Database>,
  schoolId: string,
  termId: string,
): Promise<{ resultsComputed: number; pupilsSummarized: number }> {
  const termResult = await sql<TermRow>`
    SELECT id, school_id, academic_year_id, start_date::text, end_date::text, status
    FROM terms WHERE school_id = ${schoolId}::uuid AND id = ${termId}::uuid
  `.execute(tx);
  const term = termResult.rows[0];
  if (!term) return { resultsComputed: 0, pupilsSummarized: 0 };

  const settingsResult = await sql<SettingsRow>`
    SELECT position_basis, aggregate_subject_count, pass_mark, late_counts_as_present
    FROM school_settings WHERE school_id = ${schoolId}::uuid
  `.execute(tx);
  const settings = settingsResult.rows[0];
  if (!settings) throw new Error("School settings are missing");

  const classSubjects = await sql<ClassSubjectRow>`
    SELECT c.id AS class_id, c.name AS class_name, c.level,
      cs.subject_id, s.name AS subject_name
    FROM classes c
    JOIN class_subjects cs ON cs.school_id = c.school_id AND cs.class_id = c.id
    JOIN subjects s ON s.school_id = cs.school_id AND s.id = cs.subject_id
    WHERE c.school_id = ${schoolId}::uuid
      AND c.academic_year_id = ${term.academic_year_id}::uuid
    ORDER BY c.id, s.name
  `.execute(tx);

  const totalsByPupil = new Map<string, number[]>();
  const subjectsTakenByPupil = new Map<string, number>();
  const pupilClassById = new Map<string, string>();
  const summarySnapshotByClass = new Map<string, Record<string, unknown>>();
  let resultsComputed = 0;

  await sql`
    DELETE FROM term_results r
    WHERE r.school_id = ${schoolId}::uuid
      AND r.term_id = ${termId}::uuid
      AND r.source = 'computed'
      AND (
        NOT EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.school_id = r.school_id AND e.student_id = r.student_id
            AND e.class_id = r.class_id AND e.academic_year_id = r.academic_year_id
            AND e.status = 'active'
        )
        OR NOT EXISTS (
          SELECT 1 FROM class_subjects cs
          WHERE cs.school_id = r.school_id AND cs.class_id = r.class_id
            AND cs.subject_id = r.subject_id
        )
        OR EXISTS (
          SELECT 1 FROM student_subject_opt_outs o
          JOIN class_subjects cs
            ON cs.school_id = o.school_id AND cs.id = o.class_subject_id
          WHERE o.school_id = r.school_id AND o.student_id = r.student_id
            AND cs.class_id = r.class_id AND cs.subject_id = r.subject_id
        )
      )
  `.execute(tx);

  for (const classSubject of classSubjects.rows) {
    const schemeResult = await sql<{
      id: string;
      name: string;
      sba_weight: Numeric;
      exam_weight: Numeric;
      exam_max_mark: Numeric;
    }>`
      SELECT id, name, sba_weight, exam_weight, exam_max_mark
      FROM grading_schemes
      WHERE school_id = ${schoolId}::uuid AND is_default
        AND ${classSubject.level} BETWEEN level_from AND level_to
      ORDER BY CASE WHEN name IN ('Primary scheme', 'JHS scheme') THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `.execute(tx);
    const scheme = schemeResult.rows[0];
    if (!scheme) throw new Error(`No grading scheme applies to level ${classSubject.level}`);

    const overrideResult = await sql<{
      subject_id: string | null;
      level: number | null;
      class_score_weight: Numeric;
      exam_weight: Numeric;
    }>`
      SELECT subject_id, level, class_score_weight, exam_weight
      FROM grading_scheme_overrides
      WHERE scheme_id = ${scheme.id}::uuid
        AND (subject_id IS NULL OR subject_id = ${classSubject.subject_id}::uuid)
        AND (level IS NULL OR level = ${classSubject.level})
    `.execute(tx);
    const weights = resolveWeights(
      { sbaWeight: Number(scheme.sba_weight), examWeight: Number(scheme.exam_weight) },
      overrideResult.rows.map((override) => ({
        subjectId: override.subject_id,
        level: override.level,
        sbaWeight: Number(override.class_score_weight),
        examWeight: Number(override.exam_weight),
      })),
      classSubject.subject_id,
      classSubject.level,
    );

    const scaleRows = await sql<{
      id: string;
      kind: GradingScale["kind"];
      metric: GradingScale["metric"];
      lower_is_better: boolean;
    }>`
      SELECT id, kind, metric, lower_is_better
      FROM grading_scales WHERE scheme_id = ${scheme.id}::uuid
      ORDER BY kind
    `.execute(tx);
    const scales: GradingScale[] = [];
    for (const scale of scaleRows.rows) {
      const bands = await sql<{
        min_score: number;
        max_score: number;
        label: string;
        points: Numeric | null;
        descriptor: string | null;
        is_credit: boolean;
        is_pass: boolean;
      }>`
        SELECT min_score, max_score, label, points, descriptor, is_credit, is_pass
        FROM grade_bands WHERE scale_id = ${scale.id}::uuid ORDER BY min_score
      `.execute(tx);
      scales.push({
        kind: scale.kind,
        metric: scale.metric,
        lowerIsBetter: scale.lower_is_better,
        bands: bandRecord(bands.rows),
      });
    }

    const enrolleeResult = await sql<EnrolleeRow>`
      SELECT e.student_id, e.class_id, e.roll_number
      FROM enrollments e
      WHERE e.school_id = ${schoolId}::uuid
        AND e.class_id = ${classSubject.class_id}::uuid
        AND e.academic_year_id = ${term.academic_year_id}::uuid
        AND e.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM student_subject_opt_outs o
          JOIN class_subjects cs
            ON cs.school_id = o.school_id AND cs.id = o.class_subject_id
          WHERE o.school_id = e.school_id
            AND o.student_id = e.student_id
            AND cs.class_id = e.class_id
            AND cs.subject_id = ${classSubject.subject_id}::uuid
        )
      ORDER BY e.roll_number
    `.execute(tx);
    const enrollees = enrolleeResult.rows;
    for (const enrollee of enrollees) {
      subjectsTakenByPupil.set(
        enrollee.student_id,
        (subjectsTakenByPupil.get(enrollee.student_id) ?? 0) + 1,
      );
      pupilClassById.set(enrollee.student_id, enrollee.class_id);
      if (!totalsByPupil.has(enrollee.student_id)) totalsByPupil.set(enrollee.student_id, []);
    }

    const componentRows = await sql<{
      assessment_id: string;
      component_name: string;
      component_kind: "sba" | "exam";
      max_mark: Numeric;
      student_id: string | null;
      mark: Numeric | null;
      score_status: "scored" | "absent" | "excused" | null;
    }>`
      SELECT a.id AS assessment_id, sc.name AS component_name, sc.kind AS component_kind,
        a.max_mark, scores.student_id, scores.mark,
        scores.status AS score_status
      FROM assessments a
      JOIN scheme_components sc
        ON sc.school_id = a.school_id AND sc.id = a.scheme_component_id
      LEFT JOIN scores ON scores.school_id = a.school_id AND scores.assessment_id = a.id
      WHERE a.school_id = ${schoolId}::uuid
        AND a.term_id = ${termId}::uuid
        AND a.class_id = ${classSubject.class_id}::uuid
        AND a.subject_id = ${classSubject.subject_id}::uuid
      ORDER BY sc.sort_order
    `.execute(tx);

    const componentDefinitions = new Map<string, {
      kind: "sba" | "exam";
      name: string;
      maxMark: string;
      scores: Map<string, AssessmentScore["score"]>;
    }>();
    for (const row of componentRows.rows) {
      let component = componentDefinitions.get(row.assessment_id);
      if (!component) {
        component = {
          kind: row.component_kind,
          name: row.component_name,
          maxMark: String(row.max_mark),
          scores: new Map(),
        };
        componentDefinitions.set(row.assessment_id, component);
      }
      if (row.student_id && row.score_status) {
        component.scores.set(row.student_id, {
          mark: row.mark === null ? null : String(row.mark),
          status: row.score_status,
        });
      }
    }

    const subjectSnapshot = {
      schemeId: scheme.id,
      schemeName: scheme.name,
      level: classSubject.level,
      sbaWeight: weights.sbaWeight,
      examWeight: weights.examWeight,
      components: [...componentDefinitions.values()].map(({ kind, name, maxMark }) => ({ kind, name, maxMark })),
      scales,
    };
    const summarySnapshot = summarySnapshotByClass.get(classSubject.class_id) ?? {
      settings: {
        positionBasis: settings.position_basis,
        aggregateSubjectCount: settings.aggregate_subject_count,
        passMark: settings.pass_mark,
      },
      subjects: {},
    };
    (summarySnapshot.subjects as Record<string, unknown>)[classSubject.subject_id] = subjectSnapshot;
    summarySnapshotByClass.set(classSubject.class_id, summarySnapshot);

    for (const enrollee of enrollees) {
      const components: AssessmentScore[] = [...componentDefinitions.entries()].map(([, component]) => ({
        kind: component.kind,
        name: component.name,
        maxMark: component.maxMark,
        ...(component.scores.has(enrollee.student_id)
          ? { score: component.scores.get(enrollee.student_id)! }
          : {}),
      }));
      const calculated = calculateResult({
        components,
        sbaWeight: weights.sbaWeight,
        examWeight: weights.examWeight,
        scales,
      });
      const gradeScale = scales.find((scale) => scale.kind === "letter" || scale.kind === "number")
        ?? scales.find((scale) => scale.kind === "proficiency");
      const grade = calculated.total === null || !gradeScale
        ? undefined
        : lookupGrade(calculated.total, gradeScale);
      const snapshot = {
        ...calculated.schemeSnapshot,
        schemeId: scheme.id,
        schemeName: scheme.name,
        level: classSubject.level,
        subjectId: classSubject.subject_id,
        weights,
        settings: summarySnapshot.settings,
      };

      await sql`
        INSERT INTO term_results (
          school_id, academic_year_id, student_id, class_id, subject_id, term_id,
          class_score_pct, exam_score_pct, total, grade_label, grade_points,
          subject_rank, status, source, scheme_snapshot, sba_raw, sba_max,
          exam_raw, exam_max, sba_scaled, exam_scaled, grades, incomplete_reason,
          subject_position, computed_at
        ) VALUES (
          ${schoolId}::uuid, ${term.academic_year_id}::uuid, ${enrollee.student_id}::uuid,
          ${classSubject.class_id}::uuid, ${classSubject.subject_id}::uuid, ${termId}::uuid,
          CASE WHEN ${calculated.sbaMax}::numeric > 0
            THEN round(${calculated.sbaRaw}::numeric / ${calculated.sbaMax}::numeric * 100, 1)
            ELSE NULL END,
          CASE WHEN ${calculated.examMax}::numeric > 0 AND ${calculated.examRaw}::numeric IS NOT NULL
            THEN round(${calculated.examRaw}::numeric / ${calculated.examMax}::numeric * 100, 1)
            ELSE NULL END,
          ${calculated.total}, ${calculated.total === null ? null : calculated.grades.letter ?? calculated.grades.number ?? calculated.grades.proficiency ?? null},
          ${grade?.points ?? null}, NULL, ${calculated.status}, 'computed',
          ${JSON.stringify(snapshot)}::jsonb,
          ${calculated.sbaRaw}, ${calculated.sbaMax}, ${calculated.examRaw},
          ${calculated.examMax}, ${calculated.sbaScaled}, ${calculated.examScaled},
          ${JSON.stringify(calculated.grades)}::jsonb, ${calculated.incompleteReason},
          NULL, now()
        )
        ON CONFLICT (school_id, student_id, subject_id, term_id) DO UPDATE SET
          class_id = EXCLUDED.class_id,
          academic_year_id = EXCLUDED.academic_year_id,
          class_score_pct = EXCLUDED.class_score_pct,
          exam_score_pct = EXCLUDED.exam_score_pct,
          total = EXCLUDED.total,
          grade_label = EXCLUDED.grade_label,
          grade_points = EXCLUDED.grade_points,
          status = EXCLUDED.status,
          source = 'computed',
          scheme_snapshot = EXCLUDED.scheme_snapshot,
          sba_raw = EXCLUDED.sba_raw,
          sba_max = EXCLUDED.sba_max,
          exam_raw = EXCLUDED.exam_raw,
          exam_max = EXCLUDED.exam_max,
          sba_scaled = EXCLUDED.sba_scaled,
          exam_scaled = EXCLUDED.exam_scaled,
          grades = EXCLUDED.grades,
          incomplete_reason = EXCLUDED.incomplete_reason,
          computed_at = now()
      `.execute(tx);
      if (calculated.status === "complete" && calculated.total !== null) {
        totalsByPupil.get(enrollee.student_id)!.push(calculated.total);
      }
      resultsComputed += 1;
    }

    await sql`
      WITH ranked AS (
        SELECT id, rank() OVER (ORDER BY total DESC)::integer AS position
        FROM term_results
        WHERE school_id = ${schoolId}::uuid
          AND class_id = ${classSubject.class_id}::uuid
          AND subject_id = ${classSubject.subject_id}::uuid
          AND term_id = ${termId}::uuid
          AND status = 'complete'
      )
      UPDATE term_results r
      SET subject_rank = ranked.position, subject_position = ranked.position
      FROM ranked WHERE r.id = ranked.id
    `.execute(tx);
    await sql`
      UPDATE term_results SET subject_rank = NULL, subject_position = NULL
      WHERE school_id = ${schoolId}::uuid
        AND class_id = ${classSubject.class_id}::uuid
        AND subject_id = ${classSubject.subject_id}::uuid
        AND term_id = ${termId}::uuid AND status = 'incomplete'
    `.execute(tx);
  }

  const pupilsByClass = new Map<string, string[]>();
  for (const [studentId, classId] of pupilClassById) {
    const list = pupilsByClass.get(classId) ?? [];
    list.push(studentId);
    pupilsByClass.set(classId, list);
  }
  const activePupils = await sql<{ student_id: string; class_id: string }>`
    SELECT student_id, class_id FROM enrollments
    WHERE school_id = ${schoolId}::uuid
      AND academic_year_id = ${term.academic_year_id}::uuid
      AND status = 'active'
  `.execute(tx);
  for (const pupil of activePupils.rows) {
    pupilClassById.set(pupil.student_id, pupil.class_id);
    if (!totalsByPupil.has(pupil.student_id)) totalsByPupil.set(pupil.student_id, []);
    const list = pupilsByClass.get(pupil.class_id) ?? [];
    if (!list.includes(pupil.student_id)) list.push(pupil.student_id);
    pupilsByClass.set(pupil.class_id, list);
  }
  let pupilsSummarized = 0;
  for (const [classId, pupilIds] of pupilsByClass) {
    const classResult = classSubjects.rows.find((row) => row.class_id === classId);
    if (!classResult) continue;
    const enrollmentCount = await sql<{ count: number }>`
      SELECT count(*)::integer AS count FROM enrollments
      WHERE school_id = ${schoolId}::uuid
        AND class_id = ${classId}::uuid
        AND academic_year_id = ${term.academic_year_id}::uuid
        AND status = 'active'
    `.execute(tx);
    const summaries = pupilIds.map((studentId) => ({
      studentId,
      summary: summarizePupil({
        totals: totalsByPupil.get(studentId) ?? [],
        subjectsTaken: subjectsTakenByPupil.get(studentId) ?? 0,
        aggregateSubjectCount: settings.aggregate_subject_count,
        positionBasis: settings.position_basis,
        passMark: settings.pass_mark,
      }),
    }));
    const positions = competitionRanks(summaries.map(({ summary }) => summary.positionScore));
    for (const [index, item] of summaries.entries()) {
      const snapshot = summarySnapshotByClass.get(classId) ?? {};
      const overallScale = await sql<{ min_score: number; max_score: number; label: string }>`
        SELECT b.min_score, b.max_score, b.label
        FROM grading_scales g
        JOIN grade_bands b ON b.school_id = g.school_id AND b.scale_id = g.id
        WHERE g.school_id = ${schoolId}::uuid
          AND g.kind = 'overall_comment'
          AND g.metric = 'average'
          AND ${classResult.level} BETWEEN
            (SELECT level_from FROM grading_schemes WHERE id = g.scheme_id)
            AND (SELECT level_to FROM grading_schemes WHERE id = g.scheme_id)
          AND ${item.summary.average ?? -1} BETWEEN b.min_score AND b.max_score
        ORDER BY CASE WHEN (SELECT name FROM grading_schemes WHERE id = g.scheme_id)
          IN ('Primary scheme', 'JHS scheme') THEN 0 ELSE 1 END
        LIMIT 1
      `.execute(tx);
      await sql`
        INSERT INTO term_summaries (
          school_id, academic_year_id, student_id, class_id, term_id,
          results_complete, total_raw, out_of, average, aggregate, overall_position,
          subjects_passed, subjects_failed, class_enrolment, overall_comment,
          scheme_snapshot, computed_at
        ) VALUES (
          ${schoolId}::uuid, ${term.academic_year_id}::uuid, ${item.studentId}::uuid,
          ${classId}::uuid, ${termId}::uuid, ${totalsByPupil.get(item.studentId)?.length ?? 0},
          ${item.summary.totalRaw}, ${item.summary.outOf}, ${item.summary.average},
          ${item.summary.aggregate}, ${positions[index]}, ${item.summary.subjectsPassed},
          ${item.summary.subjectsFailed}, ${enrollmentCount.rows[0]?.count ?? 0},
          ${overallScale.rows[0]?.label ?? null}, ${JSON.stringify(snapshot)}::jsonb, now()
        )
        ON CONFLICT (school_id, student_id, term_id) DO UPDATE SET
          class_id = EXCLUDED.class_id,
          results_complete = EXCLUDED.results_complete,
          total_raw = EXCLUDED.total_raw,
          out_of = EXCLUDED.out_of,
          average = EXCLUDED.average,
          aggregate = EXCLUDED.aggregate,
          overall_position = EXCLUDED.overall_position,
          subjects_passed = EXCLUDED.subjects_passed,
          subjects_failed = EXCLUDED.subjects_failed,
          class_enrolment = EXCLUDED.class_enrolment,
          overall_comment = EXCLUDED.overall_comment,
          scheme_snapshot = EXCLUDED.scheme_snapshot,
          computed_at = now()
      `.execute(tx);
      pupilsSummarized += 1;
    }
  }

  await computeTermAttendance(tx, schoolId, term, settings);
  return { resultsComputed, pupilsSummarized };
}

export async function recomputeTermAttendance(
  tx: Transaction<Database>,
  schoolId: string,
  termId: string,
): Promise<void> {
  const termResult = await sql<TermRow>`
    SELECT id, school_id, academic_year_id, start_date::text, end_date::text, status
    FROM terms WHERE school_id = ${schoolId}::uuid AND id = ${termId}::uuid
  `.execute(tx);
  const term = termResult.rows[0];
  if (!term) return;
  const settingsResult = await sql<SettingsRow>`
    SELECT position_basis, aggregate_subject_count, pass_mark, late_counts_as_present
    FROM school_settings WHERE school_id = ${schoolId}::uuid
  `.execute(tx);
  const settings = settingsResult.rows[0];
  if (!settings) throw new Error("School settings are missing");
  await computeTermAttendance(tx, schoolId, term, settings);
}

async function computeTermAttendance(
  tx: Transaction<Database>,
  schoolId: string,
  term: TermRow,
  settings: SettingsRow,
): Promise<void> {
  const rows = await sql<{
    student_id: string;
    class_id: string;
    days_open: number;
    days_present: number;
  }>`
    SELECT e.student_id, e.class_id,
      count(DISTINCT r.id)::integer AS days_open,
      count(DISTINCT r.id) FILTER (
        WHERE a.id IS NULL
          OR a.status = 'present'
          OR (${settings.late_counts_as_present} AND a.status = 'late')
      )::integer AS days_present
    FROM enrollments e
    JOIN classes c
      ON c.school_id = e.school_id AND c.id = e.class_id
    LEFT JOIN attendance_registers r
      ON r.school_id = e.school_id
      AND r.class_id = e.class_id
      AND r.academic_year_id = e.academic_year_id
      AND r.status = 'submitted'
      AND r.register_date BETWEEN GREATEST(${term.start_date}::date, e.start_date)
        AND LEAST(${term.end_date}::date, COALESCE(e.end_date, ${term.end_date}::date))
    LEFT JOIN attendance a
      ON a.school_id = r.school_id AND a.register_id = r.id AND a.student_id = e.student_id
    WHERE e.school_id = ${schoolId}::uuid
      AND e.academic_year_id = ${term.academic_year_id}::uuid
      AND e.status = 'active'
    GROUP BY e.student_id, e.class_id
  `.execute(tx);

  for (const row of rows.rows) {
    if (row.days_open === 0) continue;
    await sql`
      INSERT INTO term_attendance (
        school_id, student_id, class_id, term_id, days_present, days_open, source
      ) VALUES (
        ${schoolId}::uuid, ${row.student_id}::uuid, ${row.class_id}::uuid,
        ${term.id}::uuid, ${row.days_present}, ${row.days_open}, 'computed'
      )
      ON CONFLICT (school_id, student_id, term_id) DO UPDATE SET
        class_id = EXCLUDED.class_id,
        days_present = EXCLUDED.days_present,
        days_open = EXCLUDED.days_open,
        source = 'computed',
        computed_at = now()
    `.execute(tx);
  }
}
