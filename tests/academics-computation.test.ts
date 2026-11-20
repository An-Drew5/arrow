import { describe, expect, it } from "vitest";
import {
  calculateResult,
  competitionRanks,
  lookupGrade,
  ordinalLabel,
  resolveWeights,
  summarizePupil,
  type AssessmentScore,
  type GradingScale,
  type ScoreStatus,
} from "../src/academics/computation";

const components = [
  { kind: "sba" as const, name: "Class exercise", maxMark: 15 },
  { kind: "sba" as const, name: "Group work", maxMark: 15 },
  { kind: "sba" as const, name: "Class test", maxMark: 15 },
  { kind: "sba" as const, name: "Project work", maxMark: 15 },
  { kind: "exam" as const, name: "Exam", maxMark: 100 },
];

const letter: GradingScale = {
  kind: "letter",
  metric: "subject_total",
  lowerIsBetter: false,
  bands: [
    { minScore: 90, maxScore: 100, label: "A+" },
    { minScore: 80, maxScore: 89, label: "A" },
    { minScore: 75, maxScore: 79, label: "B+" },
    { minScore: 70, maxScore: 74, label: "B" },
    { minScore: 65, maxScore: 69, label: "C+" },
    { minScore: 60, maxScore: 64, label: "C" },
    { minScore: 50, maxScore: 59, label: "D" },
    { minScore: 40, maxScore: 49, label: "E" },
    { minScore: 0, maxScore: 39, label: "F" },
  ],
};

const proficiency: GradingScale = {
  kind: "proficiency",
  metric: "subject_total",
  lowerIsBetter: false,
  bands: [
    { minScore: 80, maxScore: 100, label: "Highly Proficient" },
    { minScore: 68, maxScore: 79, label: "Proficient" },
    { minScore: 54, maxScore: 67, label: "Approaching Proficient" },
    { minScore: 40, maxScore: 53, label: "Developing Proficient" },
    { minScore: 0, maxScore: 39, label: "Emerging Proficient" },
  ],
};

const number: GradingScale = {
  kind: "number",
  metric: "subject_total",
  lowerIsBetter: true,
  bands: [
    { minScore: 75, maxScore: 100, label: "1" },
    { minScore: 70, maxScore: 74, label: "2" },
    { minScore: 65, maxScore: 69, label: "3" },
    { minScore: 60, maxScore: 64, label: "4" },
    { minScore: 55, maxScore: 59, label: "5" },
    { minScore: 50, maxScore: 54, label: "6" },
    { minScore: 45, maxScore: 49, label: "7" },
    { minScore: 40, maxScore: 44, label: "8" },
    { minScore: 0, maxScore: 39, label: "9" },
  ],
};

function scored(
  marks: (number | null)[],
  statuses: (ScoreStatus | "missing")[] = marks.map(() => "scored"),
): AssessmentScore[] {
  return components.map((component, index) => {
    const status = statuses[index];
    if (status === undefined || status === "missing") return { ...component };
    return {
      ...component,
      score: {
        mark: status === "scored" ? marks[index] ?? null : null,
        status,
      },
    };
  });
}

describe("academic result computation", () => {
  it.each([
    { marks: [12, 10, 14, 9, 70], total: 73, letter: "B", proficiency: "Proficient", number: "2" },
    { marks: [10, 10, 10, 8, 34], total: 49, letter: "E", proficiency: "Developing Proficient", number: "7" },
    { marks: [15, 15, 15, 15, 33], total: 67, letter: "C+", proficiency: "Approaching Proficient", number: "3" },
  ])("calculates a complete result: $total", ({ marks, total, letter: letterLabel, proficiency: proficiencyLabel, number: numberLabel }) => {
    const result = calculateResult({
      components: scored(marks),
      sbaWeight: 50,
      examWeight: 50,
      scales: [letter, proficiency, number],
    });
    expect(result.total).toBe(total);
    expect(result.status).toBe("complete");
    expect(result.grades).toEqual({ letter: letterLabel, proficiency: proficiencyLabel, number: numberLabel });
  });

  it("uses half-up rounding, excludes excused SBA maxima and counts absent SBA as zero", () => {
    const excused = calculateResult({
      components: scored([15, 12, null, 10, 80], ["scored", "scored", "excused", "scored", "scored"]),
      sbaWeight: 50,
      examWeight: 50,
      scales: [letter, proficiency],
    });
    expect(excused.total).toBe(81);
    expect(excused.grades).toEqual({ letter: "A", proficiency: "Highly Proficient" });

    const absent = calculateResult({
      components: scored([15, null, 14, 9, 70], ["scored", "absent", "scored", "scored", "scored"]),
      sbaWeight: 50,
      examWeight: 50,
      scales: [letter],
    });
    expect(absent.total).toBe(67);

    const half = calculateResult({
      components: scored([15, 15, 15, 15, 33]),
      sbaWeight: 50,
      examWeight: 50,
      scales: [],
    });
    expect(half.examScaled).toBe(17);
  });

  it("returns an incomplete result without grades for missing or absent exams", () => {
    for (const status of ["missing", "absent", "excused"] as const) {
      const statuses: (ScoreStatus | "missing")[] = ["scored", "scored", "scored", "scored", status];
      const result = calculateResult({
        components: scored([15, 15, 15, 15, null], statuses),
        sbaWeight: 50,
        examWeight: 50,
        scales: [letter],
      });
      expect(result.status).toBe("incomplete");
      expect(result.total).toBeNull();
      expect(result.grades).toEqual({});
      expect(result.incompleteReason).toContain("Exam");
    }
  });

  it("resolves the most-specific matching weight override", () => {
    const overrides = [
      { subjectId: null, level: 4, sbaWeight: 45, examWeight: 55 },
      { subjectId: "math", level: null, sbaWeight: 40, examWeight: 60 },
      { subjectId: "math", level: 4, sbaWeight: 35, examWeight: 65 },
    ];
    expect(resolveWeights({ sbaWeight: 50, examWeight: 50 }, overrides, "math", 4))
      .toEqual({ sbaWeight: 35, examWeight: 65 });
    const result = calculateResult({
      components: scored([12, 11, 11, 11, 70]),
      sbaWeight: 40,
      examWeight: 60,
      scales: [],
    });
    expect(result.total).toBe(72);
  });

  it("looks up inclusive bands and preserves a snapshot from caller mutations", () => {
    const mutableLetter: GradingScale = structuredClone(letter);
    const result = calculateResult({
      components: scored([15, 15, 15, 15, 100]),
      sbaWeight: 50,
      examWeight: 50,
      scales: [mutableLetter],
    });
    mutableLetter.bands[0]!.label = "changed";
    expect(result.schemeSnapshot.scales[0]?.bands[0]?.label).toBe("A+");
    expect(lookupGrade(90, result.schemeSnapshot.scales[0]! )?.label).toBe("A+");
  });

  it("computes aggregates, competition ranks, and ordinals", () => {
    expect(summarizePupil({
      totals: [81, 73, 67, 49, 90, 60, 55, 44, 70],
      subjectsTaken: 9,
      aggregateSubjectCount: 6,
      positionBasis: "best_n",
      passMark: 40,
    })).toMatchObject({ aggregate: 441, average: 65, subjectsPassed: 9, subjectsFailed: 0 });
    expect(summarizePupil({
      totals: [90, 80],
      subjectsTaken: 6,
      aggregateSubjectCount: 6,
      positionBasis: "best_n",
      passMark: 40,
    })).toMatchObject({ aggregate: null, positionScore: null, unrankable: true });
    expect(summarizePupil({
      totals: [90, 80],
      subjectsTaken: 6,
      aggregateSubjectCount: 6,
      positionBasis: "all_subjects",
      passMark: 40,
    }).positionScore).toBeNull();
    expect(summarizePupil({
      totals: [90, 80, 60, 50, 40, 30],
      subjectsTaken: 6,
      aggregateSubjectCount: 6,
      positionBasis: "all_subjects",
      passMark: 40,
    }).positionScore).toBe(350);
    expect(competitionRanks([441, 441, 400, 380, 380, 300])).toEqual([1, 1, 3, 4, 4, 6]);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinalLabel))
      .toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th"]);
  });

  it("uses the JHS core-subject rule and leaves Primary aggregates unchanged", () => {
    const subjects = [
      { subjectId: "english", subjectName: "English", isCore: true, total: 60 },
      { subjectId: "maths", subjectName: "Mathematics", isCore: true, total: 65 },
      { subjectId: "science", subjectName: "Integrated Science", isCore: true, total: 70 },
      { subjectId: "social", subjectName: "Social Studies", isCore: true, total: 50 },
      { subjectId: "french", subjectName: "French", isCore: false, total: 100 },
      { subjectId: "art", subjectName: "Art", isCore: false, total: 95 },
      { subjectId: "ict", subjectName: "ICT", isCore: false, total: 90 },
    ] as const;
    const jhs = summarizePupil({
      totals: subjects.map(({ total }) => total),
      subjectsTaken: subjects.length,
      aggregateSubjectCount: 6,
      positionBasis: "all_subjects",
      passMark: 40,
      level: 7,
      subjects,
    });
    expect(jhs).toMatchObject({
      aggregate: 440,
      positionScore: 440,
      aggregateSubjects: [
        { subjectId: "english", total: 60 },
        { subjectId: "maths", total: 65 },
        { subjectId: "science", total: 70 },
        { subjectId: "social", total: 50 },
        { subjectId: "french", total: 100 },
        { subjectId: "art", total: 95 },
      ],
    });
    expect(jhs.aggregate).not.toBe(480);

    const missingCore = summarizePupil({
      totals: [60, 65, 70, 100, 95, 90],
      subjectsTaken: 7,
      aggregateSubjectCount: 6,
      positionBasis: "best_n",
      passMark: 40,
      level: 7,
      subjects: subjects.map((subject) => ({
        ...subject,
        total: subject.subjectId === "social" ? null : subject.total,
      })),
    });
    expect(missingCore).toMatchObject({
      aggregate: null,
      positionScore: null,
      aggregateSubjects: [],
      unrankable: true,
    });

    const fewerOtherSubjects = summarizePupil({
      totals: [60, 65, 70, 50, 100],
      subjectsTaken: 5,
      aggregateSubjectCount: 6,
      positionBasis: "best_n",
      passMark: 40,
      level: 7,
      subjects: subjects.slice(0, 5),
    });
    expect(fewerOtherSubjects).toMatchObject({
      aggregate: 345,
      aggregateSubjects: expect.arrayContaining([
        expect.objectContaining({ subjectId: "french", total: 100 }),
      ]),
    });

    const primary = summarizePupil({
      totals: subjects.map(({ total }) => total),
      subjectsTaken: subjects.length,
      aggregateSubjectCount: 6,
      positionBasis: "all_subjects",
      passMark: 40,
      level: 6,
      subjects,
    });
    expect(primary.aggregate).toBe(480);
    expect(primary.positionScore).toBe(530);
  });

  it("rejects fractional marks beyond one decimal place and invalid weights", () => {
    expect(calculateResult({
      components: [{ kind: "sba", name: "SBA", maxMark: "15.00", score: { mark: "12.00", status: "scored" } }],
      sbaWeight: 50,
      examWeight: 50,
      scales: [],
    }).sbaRaw).toBe(12);
    expect(() => calculateResult({
      components: [{ kind: "sba", name: "SBA", maxMark: 10, score: { mark: 1.25, status: "scored" } }],
      sbaWeight: 50,
      examWeight: 50,
      scales: [],
    })).toThrow(/one decimal place/);
    expect(() => calculateResult({
      components: [{ kind: "sba", name: "SBA", maxMark: 15, score: { mark: "12.01", status: "scored" } }],
      sbaWeight: 50,
      examWeight: 50,
      scales: [],
    })).toThrow(/one decimal place/);
    expect(() => calculateResult({ components: [], sbaWeight: 51, examWeight: 50, scales: [] }))
      .toThrow(/total 100/);
  });
});
