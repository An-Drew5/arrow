import { sql, type Transaction } from "kysely";
import type { Database } from "../shared/db/database";

interface DefaultBand {
  minScore: number;
  maxScore: number;
  label: string;
  points: number;
  descriptor?: string;
  isCredit: boolean;
  isPass: boolean;
}

interface DefaultScheme {
  name: string;
  description: string;
  levelFrom: number;
  levelTo: number;
  scaleType: "percentage_bands" | "descriptors";
  lowerIsBetter: boolean;
  classScoreWeight: number;
  examWeight: number;
  bands: DefaultBand[];
}

const defaults: DefaultScheme[] = [
  {
    name: "JHS nine-point",
    description:
      "Editable default; not verified against an official GES document.",
    levelFrom: 7,
    levelTo: 9,
    scaleType: "percentage_bands",
    lowerIsBetter: true,
    classScoreWeight: 30,
    examWeight: 70,
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
    name: "Primary A-F",
    description:
      "Editable default; not verified against an official GES document.",
    levelFrom: 1,
    levelTo: 6,
    scaleType: "percentage_bands",
    lowerIsBetter: false,
    classScoreWeight: 30,
    examWeight: 70,
    bands: [
      { minScore: 90, maxScore: 100, label: "A+", points: 7, descriptor: "Outstanding", isCredit: true, isPass: true },
      { minScore: 80, maxScore: 89, label: "A", points: 6, descriptor: "Excellent", isCredit: true, isPass: true },
      { minScore: 70, maxScore: 79, label: "B", points: 5, descriptor: "Very good", isCredit: true, isPass: true },
      { minScore: 60, maxScore: 69, label: "C", points: 4, descriptor: "Good", isCredit: true, isPass: true },
      { minScore: 50, maxScore: 59, label: "D", points: 3, descriptor: "Satisfactory", isCredit: true, isPass: true },
      { minScore: 40, maxScore: 49, label: "E", points: 2, descriptor: "Needs support", isCredit: false, isPass: true },
      { minScore: 0, maxScore: 39, label: "F", points: 1, descriptor: "Needs urgent support", isCredit: false, isPass: false },
    ],
  },
];

export async function seedDefaultGradingSchemes(
  tx: Transaction<Database>,
  schoolId: string,
): Promise<void> {
  for (const scheme of defaults) {
    const inserted = await sql<{ id: string }>`
      INSERT INTO grading_schemes (
        school_id, name, description, level_from, level_to, scale_type,
        lower_is_better, class_score_weight, exam_weight, is_default
      ) VALUES (
        ${schoolId}::uuid, ${scheme.name}, ${scheme.description},
        ${scheme.levelFrom}, ${scheme.levelTo}, ${scheme.scaleType},
        ${scheme.lowerIsBetter}, ${scheme.classScoreWeight}, ${scheme.examWeight}, true
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

    for (const band of scheme.bands) {
      await sql`
        INSERT INTO grade_bands (
          school_id, scheme_id, min_score, max_score, label, points,
          descriptor, is_credit, is_pass
        ) VALUES (
          ${schoolId}::uuid, ${schemeId}::uuid, ${band.minScore}, ${band.maxScore},
          ${band.label}, ${band.points}, ${band.descriptor ?? null},
          ${band.isCredit}, ${band.isPass}
        )
        ON CONFLICT (school_id, scheme_id, label) DO NOTHING
      `.execute(tx);
    }
  }
}