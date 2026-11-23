import type { AppRouterOutputs } from "dofek-server/router";

type StrengthRow = AppRouterOutputs["trainingProgression"]["strength"][number];

const uuid = (digit: number) => `00000000-0000-0000-0000-${String(digit).padStart(12, "0")}`;

const observation = (overrides: Partial<StrengthRow["evidence"]["observations"][number]> = {}) => ({
  date: "2026-11-03",
  activityId: uuid(1),
  sourceActivityId: uuid(2),
  sourceSetId: uuid(3),
  provider: "whoop",
  setIndex: 1,
  weightKg: 60,
  reps: 8,
  rpe: 7,
  estimatedMaxKg: null,
  ...overrides,
});

const effort = { provider: "whoop", rpeSpread: 0.2, comparable: true };

export const repImprovementRow: StrengthRow = {
  identityKey: "bench-barbell",
  exerciseId: "bench",
  exerciseName: "Bench press",
  equipment: "Barbell",
  status: "ready",
  evidence: {
    kind: "rep_improvement",
    slot: 1,
    weightKg: 60,
    effort,
    observations: [
      observation({ date: "2026-11-20", activityId: uuid(4), sourceSetId: uuid(7), reps: 10 }),
      observation({ date: "2026-11-03", reps: 8 }),
    ],
  },
  latestEvidenceDate: "2026-11-20",
};

export const repImprovementWithoutBadge: StrengthRow = {
  ...repImprovementRow,
  identityKey: "bench-dumbbell",
  exerciseId: "dumbbell",
  exerciseName: "Bench press",
  equipment: "Dumbbell",
  status: null,
  evidence: {
    ...repImprovementRow.evidence,
    effort: { ...effort, comparable: false, rpeSpread: null },
    observations: [observation({ date: "2026-11-20", activityId: uuid(5), rpe: null })],
  },
};

export const flatBenchmarkRow: StrengthRow = {
  identityKey: "squat-barbell",
  exerciseId: "squat",
  exerciseName: "Squat",
  equipment: "Barbell",
  status: "stagnating",
  evidence: {
    kind: "flat_benchmark",
    formula: "Epley",
    reps: 5,
    effort,
    observedDates: 7,
    spanDays: 35,
    observedRangeKg: { min: 100, max: 101.5, spreadPercent: 1.5 },
    observations: [
      observation({ date: "2026-11-20", activityId: uuid(6), weightKg: 100, reps: 5 }),
    ],
  },
  latestEvidenceDate: "2026-11-20",
};

export const statusRowWithoutBadgeFirst: StrengthRow[] = [
  repImprovementWithoutBadge,
  repImprovementRow,
];
