import { describe, expect, it } from "vitest";
import { selectStrengthProgressionEvidence } from "./strength-progression-evidence.ts";
import { consolidateSets } from "./strength-set-estimate.ts";

const evidenceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const baseRow = {
  activity_id: evidenceId(1),
  activity_name: "Strength session",
  activity_started_at: "2026-11-10T18:00:00.000Z",
  activity_ended_at: "2026-11-10T19:00:00.000Z",
  session_date: "2026-11-10",
  source_providers: ["strong-csv"],
  source_external_ids: [],
  member_activity_ids: [evidenceId(1001)],
  timezone: "America/Los_Angeles",
  start_utc_offset_minutes: -420,
  end_utc_offset_minutes: -420,
  local_time_source: "device_timezone",
  set_id: evidenceId(2001),
  set_activity_id: evidenceId(1001),
  set_provider: "strong-csv",
  exercise_id: evidenceId(201),
  exercise_name: "Bench Press",
  equipment: "Barbell",
  muscle_groups: ["CHEST"],
  exercise_type: "STRENGTH",
  movement: "push",
  exercise_index: 0,
  set_index: 0,
  set_type: "working",
  weight_kg: 60,
  reps: 8,
  distance_meters: null,
  duration_seconds: null,
  rpe: 8,
  notes: null,
  raw: { weight: 60, weightUnit: "kg", reps: 8, rpe: 8 },
};

interface EvidenceOverrides {
  weight_kg?: number;
  reps?: number;
  rpe?: number | null;
  [key: string]: unknown;
}

const evidenceRow = (activity: number, date: string, overrides: EvidenceOverrides = {}) => {
  const weightKg = overrides.weight_kg ?? 60;
  const reps = overrides.reps ?? 8;
  const rpe = overrides.rpe === undefined ? 8 : overrides.rpe;
  return {
    ...baseRow,
    activity_id: evidenceId(activity),
    activity_started_at: `${date}T18:00:00.000Z`,
    activity_ended_at: `${date}T19:00:00.000Z`,
    session_date: date,
    member_activity_ids: [evidenceId(activity + 1000)],
    set_activity_id: evidenceId(activity + 1000),
    set_id: evidenceId(activity + 2000),
    set_provider: "strong-csv",
    source_providers: ["strong-csv"],
    exercise_index: 0,
    set_index: 0,
    set_type: "working",
    weight_kg: weightKg,
    reps,
    rpe,
    raw: { weight: weightKg, weightUnit: "kg", reps, rpe },
    ...overrides,
  };
};

const failureRaw = (weight: number, reps: number) => ({
  weight,
  weightUnit: "kg",
  reportedWeightUnit: "kg",
  reps,
  setTag: "Failure",
  exerciseName: "Bench Press (Barbell)",
});

const benchmarkRow = (activity: number, date: string, weight: number, setIndex = 0) =>
  evidenceRow(activity, date, {
    weight_kg: weight,
    reps: 5,
    set_index: setIndex,
    raw: failureRaw(weight, 5),
  });

const benchmarkRowNoRpe = (activity: number, date: string, weight: number) =>
  evidenceRow(activity, date, {
    weight_kg: weight,
    reps: 5,
    rpe: null,
    raw: failureRaw(weight, 5),
  });

type Row = ReturnType<typeof evidenceRow>;
const decide = (rows: Row[]) => selectStrengthProgressionEvidence(consolidateSets(rows).sets);

describe("selectStrengthProgressionEvidence", () => {
  it("marks repeatable rep improvement at one comparable slot with recorded effort ready", () => {
    const result = decide([
      evidenceRow(1, "2026-11-10"),
      evidenceRow(2, "2026-11-12", { reps: 10 }),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      exerciseId: baseRow.exercise_id,
      exerciseName: "Bench Press",
      equipment: "Barbell",
      status: "ready",
      latestEvidenceDate: "2026-11-14",
      evidence: {
        kind: "rep_improvement",
        effort: { provider: "strong-csv", rpeSpread: 0, comparable: true },
      },
    });
    expect(
      result[0]?.evidence.observations.map(({ date, reps, weightKg, rpe, sourceSetId }) => ({
        date,
        reps,
        weightKg,
        rpe,
        sourceSetId,
      })),
    ).toEqual([
      { date: "2026-11-14", reps: 10, weightKg: 60, rpe: 8, sourceSetId: evidenceId(2003) },
      { date: "2026-11-12", reps: 10, weightKg: 60, rpe: 8, sourceSetId: evidenceId(2002) },
      { date: "2026-11-10", reps: 8, weightKg: 60, rpe: 8, sourceSetId: evidenceId(2001) },
    ]);
  });

  it("requires the latest two comparable observations to repeat the improvement", () => {
    const flatThenJump = decide([
      evidenceRow(1, "2026-11-10"),
      evidenceRow(2, "2026-11-12"),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
    ]);
    expect(flatThenJump).toHaveLength(1);
    expect(flatThenJump[0]).toMatchObject({
      status: null,
      evidence: {
        kind: "rep_improvement",
        effort: { rpeSpread: 0, comparable: true },
      },
    });
    expect(flatThenJump[0]?.evidence.observations.map(({ reps }) => reps)).toEqual([10, 8, 8]);

    const repeated = decide([
      evidenceRow(1, "2026-11-10"),
      evidenceRow(2, "2026-11-12", { reps: 10 }),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
    ]);
    expect(repeated[0]?.status).toBe("ready");
  });

  it("reports an observed rep improvement without a status when effort is missing", () => {
    const result = decide([
      evidenceRow(1, "2026-11-10", { rpe: null }),
      evidenceRow(2, "2026-11-12", { reps: 10, rpe: null }),
      evidenceRow(3, "2026-11-14", { reps: 10, rpe: null }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: null,
      evidence: { kind: "rep_improvement", effort: { rpeSpread: null, comparable: false } },
    });
    expect(result[0]?.evidence.observations.map(({ rpe }) => rpe)).toEqual([null, null, null]);
  });

  it("reports an observed rep improvement without a status when effort is harder or incomparable", () => {
    const harder = decide([
      evidenceRow(1, "2026-11-10", { rpe: 8 }),
      evidenceRow(2, "2026-11-12", { reps: 10, rpe: 9 }),
      evidenceRow(3, "2026-11-14", { reps: 10, rpe: 10 }),
    ]);
    expect(harder[0]).toMatchObject({
      status: null,
      evidence: { kind: "rep_improvement", effort: { rpeSpread: 2, comparable: false } },
    });
    const mixedSource = decide([
      evidenceRow(1, "2026-11-10"),
      evidenceRow(2, "2026-11-12", { reps: 10, set_provider: "whoop" }),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
    ]);
    expect(mixedSource[0]).toMatchObject({
      status: null,
      evidence: { kind: "rep_improvement", effort: { comparable: false } },
    });
  });

  it("does not hide contradictory recorded RPE in a partial series", () => {
    const result = decide([
      evidenceRow(1, "2026-11-10", { rpe: 8 }),
      evidenceRow(2, "2026-11-12", { reps: 10, rpe: null }),
      evidenceRow(3, "2026-11-14", { reps: 10, rpe: 10 }),
    ]);
    expect(result[0]).toMatchObject({
      status: null,
      evidence: { kind: "rep_improvement", effort: { rpeSpread: 2, comparable: false } },
    });
    expect(result[0]?.evidence.observations.map(({ rpe }) => rpe)).toEqual([10, null, 8]);
  });

  it("selects the newest qualifying load or slot group regardless of discovery order", () => {
    const result = decide([
      evidenceRow(1, "2026-11-01", { weight_kg: 50, reps: 8 }),
      evidenceRow(2, "2026-11-03", { weight_kg: 50, reps: 10 }),
      evidenceRow(3, "2026-11-05", { weight_kg: 50, reps: 10 }),
      evidenceRow(4, "2026-11-10", { reps: 8 }),
      evidenceRow(5, "2026-11-12", { reps: 10 }),
      evidenceRow(6, "2026-11-14", { reps: 10 }),
    ]);
    expect(result[0]).toMatchObject({
      status: "ready",
      latestEvidenceDate: "2026-11-14",
      evidence: { kind: "rep_improvement", weightKg: 60 },
    });
  });

  it("does not keep an older load's ready status after a newer different-load session", () => {
    const result = decide([
      evidenceRow(1, "2026-11-10"),
      evidenceRow(2, "2026-11-12", { reps: 10 }),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
      evidenceRow(4, "2026-11-18", { weight_kg: 70, reps: 8 }),
    ]);
    expect(result).toEqual([]);
  });

  it("prefers repeatable improvement over a flat estimate when both end on the same date", () => {
    const result = decide([
      benchmarkRow(10, "2026-10-17", 100, 1),
      benchmarkRow(11, "2026-10-22", 100, 1),
      benchmarkRow(12, "2026-10-27", 101, 1),
      benchmarkRow(13, "2026-11-01", 101, 1),
      benchmarkRow(14, "2026-11-06", 100, 1),
      benchmarkRow(15, "2026-11-14", 100, 1),
      evidenceRow(20, "2026-11-01", { reps: 8 }),
      evidenceRow(21, "2026-11-10", { reps: 10 }),
      evidenceRow(22, "2026-11-14", { reps: 10 }),
    ]);
    expect(result[0]).toMatchObject({
      status: "ready",
      latestEvidenceDate: "2026-11-14",
      evidence: { kind: "rep_improvement" },
    });
  });

  it("does not shift a valid set's slot when an invalid set precedes it", () => {
    const result = decide([
      evidenceRow(1, "2026-11-10", { set_type: "warmup", reps: 8 }),
      evidenceRow(1, "2026-11-11", { set_index: 1, set_id: evidenceId(2999), reps: 8 }),
      evidenceRow(3, "2026-11-13", { reps: 10 }),
      evidenceRow(4, "2026-11-15", { reps: 10 }),
    ]);
    expect(result).toEqual([]);
  });

  it("keeps flat benchmark observations in one recorded slot and rep protocol", () => {
    const result = decide([
      benchmarkRow(1, "2026-10-17", 100, 0),
      benchmarkRow(2, "2026-10-22", 100, 1),
      benchmarkRow(3, "2026-10-27", 101, 0),
      benchmarkRow(4, "2026-11-01", 101, 1),
      benchmarkRow(5, "2026-11-06", 100, 0),
      benchmarkRow(6, "2026-11-14", 100, 1),
    ]);
    expect(result).toEqual([]);
  });

  it("marks a flat Epley benchmark across six dates and 28 days stagnating", () => {
    const result = decide([
      benchmarkRow(1, "2026-10-20", 100),
      benchmarkRow(2, "2026-10-25", 100),
      benchmarkRow(3, "2026-10-30", 101),
      benchmarkRow(4, "2026-11-04", 101),
      benchmarkRow(5, "2026-11-09", 100),
      benchmarkRow(6, "2026-11-17", 100),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: "stagnating",
      latestEvidenceDate: "2026-11-17",
      evidence: {
        kind: "flat_benchmark",
        formula: "Epley",
        reps: 5,
        observedDates: 6,
        spanDays: 28,
        observedRangeKg: { min: 116.65, max: 117.82 },
      },
    });
    expect(result[0]?.evidence.observations).toHaveLength(6);
  });

  it("allows a failure-labelled flat benchmark without any recorded RPE", () => {
    const result = decide([
      benchmarkRowNoRpe(1, "2026-10-20", 100),
      benchmarkRowNoRpe(2, "2026-10-25", 100),
      benchmarkRowNoRpe(3, "2026-10-30", 101),
      benchmarkRowNoRpe(4, "2026-11-04", 101),
      benchmarkRowNoRpe(5, "2026-11-09", 100),
      benchmarkRowNoRpe(6, "2026-11-17", 100),
    ]);
    expect(result[0]).toMatchObject({
      status: "stagnating",
      evidence: { kind: "flat_benchmark", effort: { rpeSpread: null, comparable: true } },
    });
  });

  it("does not infer stagnation from a sparse block or an increase outside the tolerance", () => {
    const sparse = decide([
      benchmarkRow(1, "2026-10-25", 100),
      benchmarkRow(2, "2026-10-30", 100),
      benchmarkRow(3, "2026-11-04", 100),
      benchmarkRow(4, "2026-11-09", 100),
      benchmarkRow(5, "2026-11-15", 100),
    ]);
    expect(sparse).toEqual([]);
    const rising = decide([
      benchmarkRow(1, "2026-10-20", 100),
      benchmarkRow(2, "2026-10-25", 102),
      benchmarkRow(3, "2026-10-30", 104),
      benchmarkRow(4, "2026-11-04", 106),
      benchmarkRow(5, "2026-11-09", 108),
      benchmarkRow(6, "2026-11-17", 110),
    ]);
    expect(rising).toEqual([]);
  });

  it("uses the observed range rather than the first and last estimated max", () => {
    const result = decide([
      benchmarkRow(1, "2026-10-20", 100),
      benchmarkRow(2, "2026-10-25", 112),
      benchmarkRow(3, "2026-10-30", 100),
      benchmarkRow(4, "2026-11-04", 112),
      benchmarkRow(5, "2026-11-09", 100),
      benchmarkRow(6, "2026-11-17", 100),
    ]);
    expect(result).toEqual([]);
  });

  it("keeps exercise and equipment identities separate", () => {
    const dumbbell = (activity: number, date: string, reps: number) =>
      evidenceRow(activity, date, {
        exercise_id: evidenceId(202),
        exercise_name: "Bench Press",
        equipment: "Dumbbell",
        reps,
      });
    const result = decide([
      evidenceRow(1, "2026-11-10"),
      evidenceRow(2, "2026-11-12", { reps: 10 }),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
      dumbbell(4, "2026-11-11", 5),
      dumbbell(5, "2026-11-13", 5),
      dumbbell(6, "2026-11-15", 5),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ equipment: "Barbell", status: "ready" });
  });

  it("deduplicates cross-provider copies of a set before counting evidence dates", () => {
    const duplicate = {
      ...evidenceRow(1, "2026-11-10"),
      set_activity_id: evidenceId(1099),
      member_activity_ids: [evidenceId(1001), evidenceId(1099)],
      set_provider: "whoop",
      set_id: evidenceId(1098),
      raw: { weight_kg: 60, number_of_reps: 8, rpe: 8 },
    };
    const result = decide([
      duplicate,
      evidenceRow(1, "2026-11-10"),
      evidenceRow(2, "2026-11-12", { reps: 10 }),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
    ]);
    expect(result[0]?.evidence.observations).toHaveLength(3);
    expect(result[0]?.status).toBe("ready");
  });

  it("does not treat a drop-set baseline as ordinary working-set improvement", () => {
    const result = decide([
      evidenceRow(1, "2026-11-10", { set_type: "dropset", reps: 8 }),
      evidenceRow(2, "2026-11-12", { reps: 10 }),
      evidenceRow(3, "2026-11-14", { reps: 10 }),
    ]);
    expect(result).toEqual([]);
  });

  it("cites the Failure-bearing source row for flat benchmark observations", () => {
    const failureRow = benchmarkRow(1, "2026-10-20", 100);
    const noFailureCopy = {
      ...failureRow,
      set_activity_id: evidenceId(1099),
      member_activity_ids: [evidenceId(1001), evidenceId(1099)],
      set_id: evidenceId(1098),
      raw: { weight: 100, weightUnit: "kg", reps: 5, rpe: 8 },
    };
    const result = decide([
      failureRow,
      noFailureCopy,
      benchmarkRow(2, "2026-10-25", 100),
      benchmarkRow(3, "2026-10-30", 101),
      benchmarkRow(4, "2026-11-04", 101),
      benchmarkRow(5, "2026-11-09", 100),
      benchmarkRow(6, "2026-11-17", 100),
    ]);
    expect(result).toHaveLength(1);
    expect(
      result[0]?.evidence.observations.find(({ date }) => date === "2026-10-20"),
    ).toMatchObject({
      sourceSetId: failureRow.set_id,
      provider: "strong-csv",
    });
  });

  it("selects the newest qualifying flat benchmark ending on the latest eligible date", () => {
    const benchmarkWithReps = (
      activity: number,
      date: string,
      weight: number,
      reps: number,
      setIndex: number,
    ) =>
      evidenceRow(activity, date, {
        weight_kg: weight,
        reps,
        set_index: setIndex,
        raw: failureRaw(weight, reps),
      });
    const weights = [100, 100, 101, 101, 100, 100];
    const result = decide([
      ...["2026-09-01", "2026-09-06", "2026-09-11", "2026-09-16", "2026-09-21", "2026-09-29"].map(
        (date, index) => benchmarkWithReps(index + 1, date, weights[index] ?? 100, 5, 0),
      ),
      ...["2026-10-20", "2026-10-25", "2026-10-30", "2026-11-04", "2026-11-09", "2026-11-17"].map(
        (date, index) => benchmarkWithReps(index + 10, date, weights[index] ?? 100, 8, 1),
      ),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: "stagnating",
      latestEvidenceDate: "2026-11-17",
      evidence: { kind: "flat_benchmark", reps: 8 },
    });
  });
});
