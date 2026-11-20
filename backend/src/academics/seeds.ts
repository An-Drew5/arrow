import { sql, type Transaction } from "kysely";
import type { Database } from "../shared/db/database";
import type { ScaleKind } from "./computation";

interface DefaultBand {
  minScore: number;
  maxScore: number;
  label: string;
  points: number | null;
  descriptor?: string;
  isCredit?: boolean;
  isPass?: boolean;
}

interface DefaultScale {
  name: string;
  kind: ScaleKind;
  metric: "subject_total" | "average";
  lowerIsBetter: boolean;
  description: string;
  bands: DefaultBand[];
}

interface DefaultScheme {
  name: string;
  description: string;
  levelFrom: number;
  levelTo: number;
  scales: DefaultScale[];
}

const components = [
  { name: "Class exercise", kind: "sba", maxMark: 15, sortOrder: 1 },
  { name: "Group work", kind: "sba", maxMark: 15, sortOrder: 2 },
  { name: "Class test", kind: "sba", maxMark: 15, sortOrder: 3 },
  { name: "Project work", kind: "sba", maxMark: 15, sortOrder: 4 },
  { name: "Exam", kind: "exam", maxMark: 100, sortOrder: 5 },
] as const;

const standardDescription = "Editable default; not verified against an official GES document.";

const primaryScales: DefaultScale[] = [
  {
    name: "Letter grade",
    kind: "letter",
    metric: "subject_total",
    lowerIsBetter: false,
    description: standardDescription,
    bands: [
      { minScore: 90, maxScore: 100, label: "A+", points: 9, descriptor: "Outstanding", isCredit: true, isPass: true },
      { minScore: 80, maxScore: 89, label: "A", points: 8, descriptor: "Excellent", isCredit: true, isPass: true },
      { minScore: 75, maxScore: 79, label: "B+", points: 7, descriptor: "Very good", isCredit: true, isPass: true },
      { minScore: 70, maxScore: 74, label: "B", points: 6, descriptor: "Good", isCredit: true, isPass: true },
      { minScore: 65, maxScore: 69, label: "C+", points: 5, descriptor: "Above average", isCredit: true, isPass: true },
      { minScore: 60, maxScore: 64, label: "C", points: 4, descriptor: "Average", isCredit: true, isPass: true },
      { minScore: 50, maxScore: 59, label: "D", points: 3, descriptor: "Satisfactory", isCredit: true, isPass: true },
      { minScore: 40, maxScore: 49, label: "E", points: 2, descriptor: "Needs support", isCredit: false, isPass: true },
      { minScore: 0, maxScore: 39, label: "F", points: 1, descriptor: "Needs urgent support", isCredit: false, isPass: false },
    ],
  },
  {
    name: "Proficiency",
    kind: "proficiency",
    metric: "subject_total",
    lowerIsBetter: false,
    description: `${standardDescription} These cut-offs are to be confirmed against the official scale.`,
    bands: [
      { minScore: 80, maxScore: 100, label: "Highly Proficient", points: null },
      { minScore: 68, maxScore: 79, label: "Proficient", points: null },
      { minScore: 54, maxScore: 67, label: "Approaching Proficient", points: null },
      { minScore: 40, maxScore: 53, label: "Developing Proficient", points: null },
      { minScore: 0, maxScore: 39, label: "Emerging Proficient", points: null },
    ],
  },
  {
    name: "Overall comment",
    kind: "overall_comment",
    metric: "average",
    lowerIsBetter: false,
    description: standardDescription,
    bands: [
      { minScore: 70, maxScore: 100, label: "Excellent Performance", points: null },
      { minScore: 55, maxScore: 69, label: "Very Good Performance", points: null },
      { minScore: 35, maxScore: 54, label: "Good Performance", points: null },
      { minScore: 20, maxScore: 34, label: "Pass", points: null },
      { minScore: 0, maxScore: 19, label: "Fail", points: null },
    ],
  },
];

const jhsScales: DefaultScale[] = [
  {
    name: "Nine-point grade",
    kind: "number",
    metric: "subject_total",
    lowerIsBetter: true,
    description: standardDescription,
    bands: [
      { minScore: 75, maxScore: 100, label: "1", points: 1, isCredit: true, isPass: true },
      { minScore: 70, maxScore: 74, label: "2", points: 2, isCredit: true, isPass: true },
      { minScore: 65, maxScore: 69, label: "3", points: 3, isCredit: true, isPass: true },
      { minScore: 60, maxScore: 64, label: "4", points: 4, isCredit: true, isPass: true },
      { minScore: 55, maxScore: 59, label: "5", points: 5, isCredit: true, isPass: true },
      { minScore: 50, maxScore: 54, label: "6", points: 6, isCredit: true, isPass: true },
      { minScore: 45, maxScore: 49, label: "7", points: 7, isCredit: false, isPass: true },
      { minScore: 40, maxScore: 44, label: "8", points: 8, isCredit: false, isPass: true },
      { minScore: 0, maxScore: 39, label: "9", points: 9, isCredit: false, isPass: false },
    ],
  },
  {
    name: "Overall comment",
    kind: "overall_comment",
    metric: "average",
    lowerIsBetter: false,
    description: `${standardDescription} Uses the primary overall-comment scale until a JHS sample is available.`,
    bands: primaryScales[2]!.bands,
  },
];

const defaults: DefaultScheme[] = [
  {
    name: "Primary scheme",
    description: `${standardDescription} Default for Primary Basic 1-6.`,
    levelFrom: 1,
    levelTo: 6,
    scales: primaryScales,
  },
  {
    name: "JHS scheme",
    description: `${standardDescription} Uses the same components pending a JHS sample.`,
    levelFrom: 7,
    levelTo: 9,
    scales: jhsScales,
  },
];

export async function seedSchoolSettings(
  tx: Transaction<Database>,
  schoolId: string,
): Promise<void> {
  await sql`
    INSERT INTO school_settings (school_id)
    VALUES (${schoolId}::uuid)
    ON CONFLICT (school_id) DO NOTHING
  `.execute(tx);
}

export async function seedDefaultGradingSchemes(
  tx: Transaction<Database>,
  schoolId: string,
): Promise<void> {
  await seedSchoolSettings(tx, schoolId);
  for (const scheme of defaults) {
    const inserted = await sql<{ id: string }>`
      INSERT INTO grading_schemes (
        school_id, name, description, level_from, level_to, scale_type,
        lower_is_better, class_score_weight, sba_weight, exam_weight,
        exam_max_mark, is_default
      ) VALUES (
        ${schoolId}::uuid, ${scheme.name}, ${scheme.description},
        ${scheme.levelFrom}, ${scheme.levelTo}, 'percentage_bands',
        ${scheme.scales.some((scale) => scale.lowerIsBetter)},
        50, 50, 50, 100, true
      )
      ON CONFLICT (school_id, name) DO NOTHING
      RETURNING id
    `.execute(tx);
    const existing = inserted.rows[0]
      ? inserted
      : await sql<{ id: string }>`
          SELECT id FROM grading_schemes
          WHERE school_id = ${schoolId}::uuid AND name = ${scheme.name}
        `.execute(tx);
    const schemeId = existing.rows[0]!.id;

    for (const component of components) {
      await sql`
        INSERT INTO scheme_components (
          school_id, scheme_id, name, kind, max_mark, sort_order
        ) VALUES (
          ${schoolId}::uuid, ${schemeId}::uuid, ${component.name},
          ${component.kind}, ${component.maxMark}, ${component.sortOrder}
        )
        ON CONFLICT DO NOTHING
      `.execute(tx);
    }

    for (const scale of scheme.scales) {
      const scaleResult = await sql<{ id: string }>`
        INSERT INTO grading_scales (
          school_id, scheme_id, name, kind, metric, lower_is_better, description
        ) VALUES (
          ${schoolId}::uuid, ${schemeId}::uuid, ${scale.name}, ${scale.kind},
          ${scale.metric}, ${scale.lowerIsBetter}, ${scale.description}
        )
        ON CONFLICT (school_id, scheme_id, kind) DO NOTHING
        RETURNING id
      `.execute(tx);
      const scaleRow = scaleResult.rows[0]
        ? scaleResult
        : await sql<{ id: string }>`
            SELECT id FROM grading_scales
            WHERE school_id = ${schoolId}::uuid
              AND scheme_id = ${schemeId}::uuid
              AND kind = ${scale.kind}
          `.execute(tx);
      const scaleId = scaleRow.rows[0]!.id;

      for (const band of scale.bands) {
        await sql`
          INSERT INTO grade_bands (
            school_id, scheme_id, scale_id, min_score, max_score, label,
            points, descriptor, is_credit, is_pass
          ) VALUES (
            ${schoolId}::uuid, ${schemeId}::uuid, ${scaleId}::uuid,
            ${band.minScore}, ${band.maxScore}, ${band.label}, ${band.points},
            ${band.descriptor ?? null}, ${band.isCredit ?? false}, ${band.isPass ?? false}
          )
          ON CONFLICT DO NOTHING
        `.execute(tx);
      }
    }
  }
}
