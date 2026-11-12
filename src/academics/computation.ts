export type ComponentKind = "sba" | "exam";
export type ScoreStatus = "scored" | "absent" | "excused";
export type ScaleKind = "letter" | "proficiency" | "number" | "overall_comment";
export type ScaleMetric = "subject_total" | "average";

export interface AssessmentScore {
  kind: ComponentKind;
  name: string;
  maxMark: string | number;
  score?: {
    mark: string | number | null;
    status: ScoreStatus;
  };
}

export interface GradeBand {
  minScore: number;
  maxScore: number;
  label: string;
  points?: number | null;
  descriptor?: string | null;
  isCredit?: boolean;
  isPass?: boolean;
}

export interface GradingScale {
  kind: ScaleKind;
  metric: ScaleMetric;
  lowerIsBetter: boolean;
  bands: readonly GradeBand[];
}

export interface ResultCalculation {
  status: "complete" | "incomplete";
  incompleteReason: string | null;
  sbaRaw: number;
  sbaMax: number;
  examRaw: number | null;
  examMax: number;
  sbaScaled: number | null;
  examScaled: number | null;
  total: number | null;
  grades: Partial<Record<ScaleKind, string>>;
  schemeSnapshot: {
    sbaWeight: number;
    examWeight: number;
    components: AssessmentScore[];
    scales: GradingScale[];
  };
}

function tenths(value: string | number): number {
  const text = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d))?$/.exec(text);
  if (!match) throw new RangeError("Marks must be non-negative with at most one decimal place");
  return Number(match[1]) * 10 + Number(match[2] ?? "0");
}

function weightHundredths(value: string | number): number {
  const text = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new RangeError("Weights must be non-negative with at most two decimal places");
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  if (result > 10_000) throw new RangeError("Weights must not exceed 100");
  return result;
}

export function roundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("Rounding requires safe integer values and a positive denominator");
  }
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

export function lookupGrade(score: number, scale: GradingScale): GradeBand | undefined {
  if (!Number.isInteger(score) || score < 0 || score > 100) return undefined;
  return scale.bands.find((band) => score >= band.minScore && score <= band.maxScore);
}

export function calculateResult(input: {
  components: readonly AssessmentScore[];
  sbaWeight: number | string;
  examWeight: number | string;
  scales: readonly GradingScale[];
}): ResultCalculation {
  const sbaWeight = weightHundredths(input.sbaWeight);
  const examWeight = weightHundredths(input.examWeight);
  if (sbaWeight + examWeight !== 10_000) {
    throw new RangeError("SBA and exam weights must total 100");
  }

  let sbaRawTenths = 0;
  let sbaMaxTenths = 0;
  let examRawTenths: number | null = null;
  let examMaxTenths = 0;
  const missingSba: string[] = [];
  let examIncomplete = false;

  for (const component of input.components) {
    const max = tenths(component.maxMark);
    if (max <= 0) throw new RangeError("Component maximum must be greater than zero");
    if (component.kind === "sba") {
      if (component.score?.status === "excused") continue;
      sbaMaxTenths += max;
      if (!component.score) {
        missingSba.push(component.name);
      } else if (component.score.status === "scored") {
        if (component.score.mark === null) throw new RangeError("Scored marks must include a mark");
        const mark = tenths(component.score.mark);
        if (mark > max) throw new RangeError("Mark must not exceed the component maximum");
        sbaRawTenths += mark;
      }
    } else {
      if (examMaxTenths !== 0) throw new RangeError("A result can have only one exam component");
      examMaxTenths = max;
      if (!component.score || component.score.status !== "scored") {
        examIncomplete = true;
      } else {
        if (component.score.mark === null) throw new RangeError("Scored marks must include a mark");
        examRawTenths = tenths(component.score.mark);
        if (examRawTenths > examMaxTenths) throw new RangeError("Mark must not exceed the component maximum");
      }
    }
  }

  if (sbaMaxTenths === 0) missingSba.push("SBA components");
  if (examMaxTenths === 0) examIncomplete = true;
  const incompleteReason = [
    ...(missingSba.length > 0 ? [`Missing SBA marks: ${missingSba.join(", ")}`] : []),
    ...(examIncomplete ? ["Exam mark is missing, absent, or excused"] : []),
  ].join("; ") || null;

  const sbaScaled = sbaMaxTenths > 0
    ? roundHalfUp(sbaRawTenths * sbaWeight, sbaMaxTenths * 100)
    : null;
  const examScaled = examRawTenths !== null && examMaxTenths > 0
    ? roundHalfUp(examRawTenths * examWeight, examMaxTenths * 100)
    : null;
  const total = incompleteReason === null && sbaScaled !== null && examScaled !== null
    ? sbaScaled + examScaled
    : null;
  const grades: Partial<Record<ScaleKind, string>> = {};
  if (total !== null) {
    for (const scale of input.scales) {
      if (scale.metric !== "subject_total") continue;
      const band = lookupGrade(total, scale);
      if (band) grades[scale.kind] = band.label;
    }
  }

  return {
    status: incompleteReason === null ? "complete" : "incomplete",
    incompleteReason,
    sbaRaw: sbaRawTenths / 10,
    sbaMax: sbaMaxTenths / 10,
    examRaw: examRawTenths === null ? null : examRawTenths / 10,
    examMax: examMaxTenths / 10,
    sbaScaled,
    examScaled,
    total,
    grades,
    schemeSnapshot: {
      sbaWeight: sbaWeight / 100,
      examWeight: examWeight / 100,
      components: input.components.map((component) => ({ ...component })),
      scales: input.scales.map((scale) => ({ ...scale, bands: scale.bands.map((band) => ({ ...band })) })),
    },
  };
}

export function resolveWeights(
  defaults: { sbaWeight: number; examWeight: number },
  overrides: readonly {
    subjectId: string | null;
    level: number | null;
    sbaWeight: number;
    examWeight: number;
  }[],
  subjectId: string,
  level: number,
): { sbaWeight: number; examWeight: number } {
  const matching = overrides.filter((item) =>
    (item.subjectId === null || item.subjectId === subjectId) &&
    (item.level === null || item.level === level),
  ).sort((left, right) => {
    const specificity = (item: (typeof overrides)[number]) =>
      Number(item.subjectId !== null) * 2 + Number(item.level !== null);
    return specificity(right) - specificity(left);
  });
  const selected = matching[0] ?? defaults;
  return { sbaWeight: selected.sbaWeight, examWeight: selected.examWeight };
}

export function competitionRanks(values: readonly (number | null)[]): (number | null)[] {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => b - a);
  return values.map((value) => value === null ? null : sorted.indexOf(value) + 1);
}

export function ordinalLabel(position: number | null): string | null {
  if (position === null) return null;
  if (!Number.isInteger(position) || position < 1) throw new RangeError("Position must be a positive integer");
  const lastTwo = position % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13
    ? "th"
    : position % 10 === 1
      ? "st"
      : position % 10 === 2
        ? "nd"
        : position % 10 === 3
          ? "rd"
          : "th";
  return `${position}${suffix}`;
}

export function summarizePupil(input: {
  totals: readonly number[];
  subjectsTaken: number;
  aggregateSubjectCount: number;
  positionBasis: "best_n" | "all_subjects";
  passMark: number;
}): {
  totalRaw: number;
  outOf: number;
  average: number | null;
  aggregate: number | null;
  positionScore: number | null;
  subjectsPassed: number;
  subjectsFailed: number;
  unrankable: boolean;
} {
  const { totals } = input;
  const required = Math.min(input.aggregateSubjectCount, input.subjectsTaken);
  const sorted = [...totals].sort((a, b) => b - a);
  const rankable = required > 0 && totals.length >= required;
  const aggregate = rankable
    ? sorted.slice(0, required).reduce((sum, total) => sum + total, 0)
    : null;
  return {
    totalRaw: totals.reduce((sum, total) => sum + total, 0),
    outOf: totals.length * 100,
    average: totals.length > 0 ? roundHalfUp(totals.reduce((sum, total) => sum + total, 0), totals.length) : null,
    aggregate,
    positionScore: !rankable
      ? null
      : input.positionBasis === "all_subjects"
      ? totals.length > 0 ? totals.reduce((sum, total) => sum + total, 0) : null
      : aggregate,
    subjectsPassed: totals.filter((total) => total >= input.passMark).length,
    subjectsFailed: totals.filter((total) => total < input.passMark).length,
    unrankable: !rankable,
  };
}
