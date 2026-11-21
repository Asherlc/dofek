import { describe, expect, it } from "vitest";
import type { FitStreamMetadata } from "./stream-decoder.ts";
import { FitWorkoutIntervalCollector } from "./workout-intervals.ts";

const sessionStart = new Date("2026-07-01T12:00:00.000Z");

const cyclingSession = {
  sport: "cycling",
  startTime: sessionStart,
  totalElapsedTime: 600,
  totalTimerTime: 590,
  totalDistance: 0,
  raw: {},
};

function metadata(overrides: Partial<FitStreamMetadata> = {}): FitStreamMetadata {
  return {
    fileId: null,
    fileType: 4,
    fileTypeName: "activity",
    fieldOccurrences: [],
    isWeightFile: false,
    recoveryError: null,
    sessionMessageCount: 1,
    workoutMessageCount: 1,
    workoutStepCount: 2,
    session: cyclingSession,
    ...overrides,
  };
}

function step(index: number, low = 1250, high = 1265, extra: Record<string, unknown> = {}) {
  return {
    message_index: index,
    wkt_step_name: `Step ${index}`,
    duration_type: 0,
    duration_value: 180000,
    target_type: 4,
    target_value: 0,
    custom_target_value_low: low,
    custom_target_value_high: high,
    intensity: 0,
    unrelated_large_field: "x".repeat(64),
    ...extra,
  };
}

function lap(
  index: number,
  stepIndex: number,
  offsetSeconds: number,
  extra: Record<string, unknown> = {},
) {
  return {
    message_index: index,
    wkt_step_index: stepIndex,
    start_time: new Date(sessionStart.getTime() + offsetSeconds * 1000).toISOString(),
    timestamp: new Date(sessionStart.getTime() + (offsetSeconds + 180) * 1000).toISOString(),
    total_timer_time: 180,
    total_elapsed_time: 180,
    ...extra,
  };
}

function build(
  steps: Record<string, unknown>[],
  laps: Record<string, unknown>[],
  meta = metadata(),
) {
  const collector = new FitWorkoutIntervalCollector();
  collector.addWorkoutSteps(steps);
  collector.addLaps(laps);
  return collector.build(meta);
}

describe("FitWorkoutIntervalCollector", () => {
  it("links repeated laps separately, sorted by recorded timing, with range, point and units", () => {
    const rows = build(
      [step(0), step(1, 1260, 1260)],
      [
        lap(2, 1, 325, { total_timer_time: 180, total_elapsed_time: 180 }),
        lap(0, 0, 0),
        lap(1, 0, 180, { total_timer_time: 134, total_elapsed_time: 145 }),
      ],
    );
    expect(rows.map((row) => row.lapMessageIndex)).toEqual([0, 1, 2]);
    expect(rows[0]).toMatchObject({
      intervalIndex: 0,
      label: "Step 0",
      startedAt: sessionStart,
      endedAt: new Date("2026-07-01T12:03:00.000Z"),
      plannedDurationSeconds: 180,
      recordedTimerDurationSeconds: 180,
      targetPowerWatts: null,
      targetPowerMinWatts: 250,
      targetPowerMaxWatts: 265,
    });
    expect(rows[1]).toMatchObject({
      recordedTimerDurationSeconds: 134,
      endedAt: new Date("2026-07-01T12:05:25.000Z"),
      plannedDurationSeconds: 180,
      targetPowerMinWatts: 250,
    });
    expect(rows[2]).toMatchObject({
      targetPowerWatts: 260,
      targetPowerMinWatts: null,
      targetPowerMaxWatts: null,
    });
    expect(rows[0]?.raw).toMatchObject({
      workoutStep: { message_index: 0, target_value: 0, duration_type: 0, target_type: 4 },
      lap: { message_index: 0, wkt_step_index: 0 },
    });
  });

  it("preserves subsecond elapsed time and does not require timestamp equality", () => {
    const [row] = build(
      [step(0)],
      [lap(0, 0, 0, { total_elapsed_time: 179.5, timestamp: "2026-07-01T12:03:00.9Z" })],
    );
    expect(row?.endedAt).toEqual(new Date("2026-07-01T12:02:59.500Z"));
  });

  it("keeps an explicit zero timer and a missing timer nullable", () => {
    const [zero] = build([step(0)], [lap(0, 0, 0, { total_timer_time: 0 })]);
    const [missing] = build([step(0)], [lap(0, 0, 0, { total_timer_time: undefined })]);
    expect(zero?.recordedTimerDurationSeconds).toBe(0);
    expect(missing?.recordedTimerDurationSeconds).toBeNull();
  });

  it.each([
    ["relative percent of FTP", 90, 105],
    ["mixed absolute and relative", 1250, 110],
    ["incomplete", 1250, undefined],
    ["reversed", 1265, 1250],
    ["boundary 1000", 1000, 1200],
    ["invalid sentinel", 4294967295, 4294967295],
  ])("rejects %s target bounds", (_name, low, high) => {
    const bounds = { custom_target_value_low: low, custom_target_value_high: high };
    expect(build([step(0, 1250, 1265, bounds)], [lap(0, 0, 0)])).toEqual([]);
  });

  it.each([
    ["non-time duration", { duration_type: 5 }],
    ["non-power target", { target_type: 1 }],
    ["preset zone target", { target_value: 3 }],
    ["non-positive duration", { duration_value: 0 }],
  ])("rejects %s", (_name, extra) => {
    expect(build([step(0, 1250, 1265, extra)], [lap(0, 0, 0)])).toEqual([]);
  });

  it("rejects duplicated step indexes, unlinked laps, duplicated lap indexes and unreferenced steps", () => {
    expect(build([step(0), step(0)], [lap(0, 0, 0)])).toEqual([]);
    expect(build([step(0)], [lap(0, 7, 0)])).toEqual([]);
    expect(build([step(0)], [lap(0, 0, 0), lap(0, 0, 180)])).toEqual([]);
    expect(
      build([step(0), step(1)], [lap(0, 0, 0), lap(1, 0, 180, { wkt_step_index: undefined })]),
    ).toHaveLength(1);
  });

  it("rejects laps with missing, reversed or out-of-session windows without inferring boundaries", () => {
    expect(build([step(0)], [lap(0, 0, 0, { start_time: undefined })])).toEqual([]);
    expect(build([step(0)], [lap(0, 0, 0, { total_elapsed_time: undefined })])).toEqual([]);
    expect(build([step(0)], [lap(0, 0, 0, { total_elapsed_time: -5 })])).toEqual([]);
    expect(build([step(0)], [lap(0, 0, 0, { total_elapsed_time: 0 })])).toEqual([]);
    expect(build([step(0)], [lap(0, 0, 500)])).toEqual([]);
    expect(build([step(0)], [lap(0, 0, -10)])).toEqual([]);
  });

  const ineligibleFiles: Array<[string, Partial<FitStreamMetadata>]> = [
    ["not an activity", { fileType: 5 }],
    ["noncycling", { session: { ...cyclingSession, sport: "running" } }],
    ["multi-session", { sessionMessageCount: 2 }],
    ["no workout header", { workoutMessageCount: 0 }],
    ["two workout headers", { workoutMessageCount: 2 }],
    ["recovered", { recoveryError: "truncated" }],
    ["no session", { session: null }],
    ["missing declared step count", { workoutStepCount: null }],
    ["zero declared step count", { workoutStepCount: 0 }],
  ];
  it.each(ineligibleFiles)("is ineligible when the file is %s", (_name, overrides) => {
    expect(build([step(0)], [lap(0, 0, 0)], metadata(overrides))).toEqual([]);
  });

  it("retains only a compact raw projection and maps numeric intensity", () => {
    const [row] = build([step(0)], [lap(0, 0, 0, { unrelated_lap_field: [1, 2, 3] })]);
    expect(row?.intervalType).toBe("active");
    expect(JSON.stringify(row?.raw)).not.toContain("unrelated");
    expect(Object.keys(row?.raw.lap ?? {}).sort()).toEqual([
      "message_index",
      "start_time",
      "timestamp",
      "total_elapsed_time",
      "total_timer_time",
      "wkt_step_index",
    ]);
  });

  it("drops both sides of overlapping lap windows but keeps touching half-open windows", () => {
    const overlapping = build([step(0)], [lap(0, 0, 0), lap(1, 0, 170), lap(2, 0, 400)]);
    expect(overlapping.map((row) => row.lapMessageIndex)).toEqual([2]);
    const touching = build([step(0)], [lap(0, 0, 0), lap(1, 0, 180)]);
    expect(touching.map((row) => row.lapMessageIndex)).toEqual([0, 1]);
    const identical = build([step(0)], [lap(0, 0, 0), lap(1, 0, 0)]);
    expect(identical).toEqual([]);
    const contained = build([step(0)], [lap(0, 0, 0, { total_elapsed_time: 300 }), lap(1, 0, 100)]);
    expect(contained).toEqual([]);
  });

  it("nulls a timer longer than elapsed (raw preserved) and rejects a lap that rounds to no window", () => {
    const [row] = build(
      [step(0)],
      [lap(0, 0, 0, { total_timer_time: 181, total_elapsed_time: 180 })],
    );
    expect(row?.recordedTimerDurationSeconds).toBeNull();
    expect(row?.raw.lap.total_timer_time).toBe(181);
    expect(build([step(0)], [lap(0, 0, 0, { total_elapsed_time: 0.0004 })])).toEqual([]);
  });

  it("rejects an unrepresentable lap end", () => {
    expect(build([step(0)], [lap(0, 0, 0, { total_elapsed_time: 1e300 })])).toEqual([]);
  });

  it("links only steps below the Workout header's declared step count", () => {
    const meta = metadata({ workoutStepCount: 1 });
    const rows = build([step(0), step(1)], [lap(0, 0, 0), lap(1, 1, 180)], meta);
    expect(rows.map((row) => row.stepMessageIndex)).toEqual([0]);
    expect(build([step(0), step(1)], [lap(0, 0, 0), lap(1, 1, 180)])).toHaveLength(2);
    expect(build([step(0)], [lap(0, 0, 0)], metadata({ workoutStepCount: 2 }))).toHaveLength(1);
  });

  it("bounds identity maps by the plain FIT message index mask (0-4095)", () => {
    expect(build([step(4096)], [lap(0, 4096, 0)])).toEqual([]);
    expect(build([step(0x8000)], [lap(0, 0x8000, 0)])).toEqual([]);
    expect(
      build([step(4095)], [lap(0, 4095, 0)], metadata({ workoutStepCount: 4096 })),
    ).toHaveLength(1);
  });
});
