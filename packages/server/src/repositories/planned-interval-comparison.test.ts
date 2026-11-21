import type { Database } from "dofek/db";
import { describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
import type { ActivitySensorWindow } from "./activity-sensor-types.ts";
import {
  evaluateCyclingEffortMetrics,
  prepareCyclingEffortMetrics,
  recordedIntervalsForActivity,
} from "./cycling-effort-metrics.ts";
import type { ComparableInterval } from "./intervals-repository.ts";
import {
  getPlannedIntervalComparisons,
  toPlannedIntervalComparison,
} from "./planned-interval-comparison.ts";

const activityId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const activity = {
  activity_id: activityId,
  member_activity_ids: [activityId, memberId],
  started_at: "2026-06-15T00:00:00.000Z",
};

function row(
  overrides: Partial<Parameters<typeof recordedIntervalsForActivity>[1][number]> = {},
): Parameters<typeof recordedIntervalsForActivity>[1][number] {
  return {
    member_activity_id: memberId,
    interval_index: 0,
    label: "Step 1",
    interval_type: "lap",
    started_at: "2026-06-15T00:00:00.000Z",
    ended_at: "2026-06-15T00:03:00.000Z",
    source_kind: "provider_recorded",
    source_provider: "garmin",
    source_activity_id: memberId,
    segment_type: null,
    target_intensity: null,
    target_zone: null,
    target_cadence_rpm: null,
    target_power_watts: null,
    target_resistance: null,
    work_recovery_kind: null,
    raw: null,
    fit_source: "workout_step_lap",
    planned_duration_seconds: 180,
    recorded_timer_duration_seconds: 134,
    target_power_min_watts: 250,
    target_power_max_watts: 265,
    ...overrides,
  };
}

describe("recordedIntervalsForActivity plans", () => {
  it("carries a range with planned time and recorded timer from one source row", () => {
    const [result] = recordedIntervalsForActivity(activity, [row()]);
    expect(result?.interval.plan).toEqual({
      fitSource: "workout_step_lap",
      target: { kind: "range", minWatts: 250, maxWatts: 265 },
      plannedDurationSeconds: 180,
      recordedTimerDurationSeconds: 134,
    });
  });

  it("carries a point target and a missing timer as null", () => {
    const [result] = recordedIntervalsForActivity(activity, [
      row({
        target_power_min_watts: null,
        target_power_max_watts: null,
        target_power_watts: 260,
        recorded_timer_duration_seconds: null,
      }),
    ]);
    expect(result?.interval.plan).toEqual({
      fitSource: "workout_step_lap",
      target: { kind: "point", watts: 260 },
      plannedDurationSeconds: 180,
      recordedTimerDurationSeconds: null,
    });
  });

  it("gives rows without a FIT source no plan", () => {
    const [result] = recordedIntervalsForActivity(activity, [
      row({
        fit_source: null,
        planned_duration_seconds: null,
        recorded_timer_duration_seconds: null,
        target_power_min_watts: null,
        target_power_max_watts: null,
        target_power_watts: 200,
      }),
    ]);
    expect(result?.interval.plan).toBeUndefined();
  });
});

describe("toPlannedIntervalComparison", () => {
  const evidence = (plan: ComparableInterval["plan"]): ComparableInterval => ({
    intervalIndex: 3,
    source: "provider_recorded",
    startOffsetSeconds: 180,
    endOffsetSeconds: 314,
    label: "Step 1",
    segmentType: null,
    workRecoveryKind: null,
    sourceProvider: "garmin",
    sourceActivityId: memberId,
    sourceMemberActivityIds: [memberId],
    targetIntensity: null,
    targetZone: null,
    targetCadenceRpm: null,
    targetPowerWatts: null,
    targetResistance: null,
    raw: null,
    plan,
  });
  const measured = { index: 3, label: "Step 1", startOffsetSeconds: 180, endOffsetSeconds: 314 };

  it("serves a signed timer difference of recorded minus planned seconds", () => {
    expect(
      toPlannedIntervalComparison(
        { ...measured, averagePowerWatts: 0 },
        evidence({
          fitSource: "workout_step_lap",
          target: { kind: "range", minWatts: 250, maxWatts: 265 },
          plannedDurationSeconds: 180,
          recordedTimerDurationSeconds: 134,
        }),
      ),
    ).toEqual({
      intervalIndex: 3,
      label: "Step 1",
      startOffsetSeconds: 180,
      endOffsetSeconds: 314,
      sourceProvider: "garmin",
      sourceActivityId: memberId,
      sourceMemberActivityIds: [memberId],
      target: { kind: "range", minWatts: 250, maxWatts: 265 },
      plannedDurationSeconds: 180,
      recordedTimerDurationSeconds: 134,
      timerDifferenceSeconds: -46,
      averagePowerWatts: 0,
    });
  });

  it("leaves the difference and average unknown when unmeasured", () => {
    const result = toPlannedIntervalComparison(
      { ...measured, averagePowerWatts: null },
      evidence({
        fitSource: "workout_step_lap",
        target: { kind: "point", watts: 260 },
        plannedDurationSeconds: 180,
        recordedTimerDurationSeconds: null,
      }),
    );
    expect(result?.timerDifferenceSeconds).toBeNull();
    expect(result?.averagePowerWatts).toBeNull();
  });

  it.each([undefined, null])("serves nothing for a %s plan", (plan) => {
    expect(
      toPlannedIntervalComparison({ ...measured, averagePowerWatts: 200 }, evidence(plan)),
    ).toBeNull();
  });
});

describe("getPlannedIntervalComparisons", () => {
  const window: ActivitySensorWindow = {
    activityId,
    userId: "user",
    startedAt: "2026-06-15 00:00:00+00",
    endedAt: "2026-06-15 00:06:00+00",
    providerType: "cycling",
    memberActivityIds: [activityId, memberId],
  };
  const lapA = row({ interval_index: 0 });
  const lapB = row({
    interval_index: 1,
    started_at: "2026-06-15T00:03:00.000Z",
    ended_at: "2026-06-15T00:05:14.000Z",
    recorded_timer_duration_seconds: 134,
  });

  function sample(elapsedSeconds: number, power: number) {
    return {
      activity_id: activityId,
      elapsed_seconds: elapsedSeconds,
      power,
      heart_rate: null,
      cadence: null,
      source_providers: ["garmin"],
      source_devices: [],
      power_measurement_kinds: ["direct"],
      stream_evidence: [["power", "garmin", null, "direct"]],
    };
  }

  function run(intervalRows: Record<string, unknown>[], samples: unknown[]) {
    const database = { execute: vi.fn(async () => intervalRows) } satisfies Pick<
      Database,
      "execute"
    >;
    const store = makeMockSensorStore(samples);
    const result = getPlannedIntervalComparisons(database, store, "user", window);
    return { result, query: vi.mocked(store.query) };
  }

  it("keeps two laps of one step separate, preserves a measured 0, and uses half-open windows", async () => {
    // Lap A is [0, 180): the sample at 180 belongs to lap B. Lap B is 100 W once, then 0 W.
    const samples = [
      ...Array.from({ length: 180 }, (_, second) => sample(second, 250)),
      sample(180, 100),
      ...Array.from({ length: 133 }, (_, offset) => sample(181 + offset, 0)),
    ];
    const { result, query } = run([lapA, lapB], samples);
    const [first, second] = await result;

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([
      expect.anything(),
      expect.stringContaining("channel IN ({channels:Array(String)})"),
      { userId: "user", activityIds: [activityId], channels: ["power"] },
    ]);
    expect(first).toMatchObject({
      intervalIndex: 0,
      endOffsetSeconds: 180,
      averagePowerWatts: 250,
    });
    expect(second).toMatchObject({
      intervalIndex: 1,
      startOffsetSeconds: 180,
      endOffsetSeconds: 314,
      recordedTimerDurationSeconds: 134,
      timerDifferenceSeconds: -46,
      averagePowerWatts: 0.7,
    });
  });

  it("returns an observed zero as zero and unmeasured laps as null", async () => {
    const samples = [...Array.from({ length: 180 }, (_, second) => sample(second, 0))];
    const { result } = run([lapA, lapB], samples);
    const [first, second] = await result;

    expect(first?.averagePowerWatts).toBe(0);
    expect(second?.averagePowerWatts).toBeNull();
  });

  it("averages only measured seconds of a partially covered lap", async () => {
    const samples = Array.from({ length: 30 }, (_, second) => sample(second, 200));
    const { result } = run([lapA], samples);

    expect((await result)[0]?.averagePowerWatts).toBe(200);
  });

  it("omits a merged lap outside the visible window", async () => {
    const outside = row({
      started_at: "2026-06-14T23:50:00.000Z",
      ended_at: "2026-06-14T23:55:00.000Z",
    });
    const { result } = run([outside], [sample(0, 200)]);

    expect(await result).toEqual([]);
  });

  it("reads no power when no stored plan is eligible", async () => {
    const legacy = row({
      fit_source: null,
      planned_duration_seconds: null,
      recorded_timer_duration_seconds: null,
      target_power_min_watts: null,
      target_power_max_watts: null,
      target_power_watts: 200,
    });
    const { result, query } = run([legacy], []);

    expect(await result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("serves no comparison for duplicate members with conflicting plans", async () => {
    const other = row({ member_activity_id: activityId, planned_duration_seconds: 120 });
    const { result } = run([lapA, other], [sample(0, 200)]);

    expect(await result).toEqual([]);
  });
});

describe("conflicting FIT plans in the legacy completion field", () => {
  it("serves no completion_pct when only planned time conflicts and point watts agree", async () => {
    const point = {
      target_power_min_watts: null,
      target_power_max_watts: null,
      target_power_watts: 200,
    };
    const intervals = recordedIntervalsForActivity(activity, [
      row({ ...point, member_activity_id: activityId }),
      row({ ...point, planned_duration_seconds: 120 }),
    ]);
    const samples = Array.from({ length: 180 }, (_, second) => ({
      elapsedSeconds: second,
      powerWatts: 200,
    }));
    const prepared = prepareCyclingEffortMetrics(samples, {
      durationSeconds: 180,
      activityDate: "2026-06-15",
      settingsHistory: [],
      activityPowerMetrics: null,
      intervals: intervals.map((item) => item.input),
      intervalEvidence: intervals,
      weightObservations: [],
      powerMeasurementKinds: [],
      sourceProviders: [],
      sourceDevices: [],
    });
    const [effort] = await evaluateCyclingEffortMetrics([prepared]);

    expect(effort?.intervals[0]).toMatchObject({ averagePowerWatts: 200, completionPct: null });
  });
});
