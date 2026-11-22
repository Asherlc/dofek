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

describe("exact plan boundaries", () => {
  const at = (seconds: number) =>
    new Date(Date.parse("2026-06-15T00:00:00.000Z") + seconds * 1_000).toISOString();

  it("keeps fractional FIT offsets while legacy rows keep rounded offsets", () => {
    const [fit, legacy] = recordedIntervalsForActivity(activity, [
      row({ ended_at: at(2.4) }),
      row({
        member_activity_id: activityId,
        fit_source: null,
        planned_duration_seconds: null,
        recorded_timer_duration_seconds: null,
        target_power_min_watts: null,
        target_power_max_watts: null,
        interval_index: 7,
        started_at: at(10),
        ended_at: at(12.6),
      }),
    ]);

    expect(fit?.interval.endOffsetSeconds).toBe(2.4);
    expect(legacy?.interval.endOffsetSeconds).toBe(13);
  });

  it("merges only equal exact boundaries", () => {
    const result = recordedIntervalsForActivity(activity, [
      row({ ended_at: at(2.4) }),
      row({ member_activity_id: activityId, ended_at: at(2.6) }),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map(({ interval }) => interval.conflicts)).toEqual([undefined, undefined]);
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

  it("serves a signed timer difference of recorded minus planned seconds", () => {
    expect(
      toPlannedIntervalComparison(
        0,
        evidence({
          fitSource: "workout_step_lap",
          target: { kind: "range", minWatts: 250, maxWatts: 265 },
          plannedDurationSeconds: 180,
          recordedTimerDurationSeconds: 134,
        }),
        400,
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
      null,
      evidence({
        fitSource: "workout_step_lap",
        target: { kind: "point", watts: 260 },
        plannedDurationSeconds: 180,
        recordedTimerDurationSeconds: null,
      }),
      400,
    );
    expect(result?.timerDifferenceSeconds).toBeNull();
    expect(result?.averagePowerWatts).toBeNull();
  });

  it.each([
    ["wholly before the canonical start", -10, -0.5, 400],
    ["wholly after the canonical end", 400, 410, 400],
    ["across a zero-length canonical window", -1, 1, 0],
  ])(
    "serves nothing for a lap %s",
    (_name, startOffsetSeconds, endOffsetSeconds, windowSeconds) => {
      const plan = {
        fitSource: "workout_step_lap" as const,
        target: { kind: "point" as const, watts: 260 },
        plannedDurationSeconds: 180,
        recordedTimerDurationSeconds: 10,
      };
      expect(
        toPlannedIntervalComparison(
          200,
          { ...evidence(plan), startOffsetSeconds, endOffsetSeconds },
          windowSeconds,
        ),
      ).toBeNull();
    },
  );

  it.each([undefined, null])("serves nothing for a %s plan", (plan) => {
    expect(toPlannedIntervalComparison(200, evidence(plan), 400)).toBeNull();
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

  function run(
    intervalRows: Record<string, unknown>[],
    samples: unknown[],
    visibleWindow: ActivitySensorWindow = window,
  ) {
    const database = { execute: vi.fn(async () => intervalRows) } satisfies Pick<
      Database,
      "execute"
    >;
    const store = makeMockSensorStore(samples);
    const result = getPlannedIntervalComparisons(database, store, "user", visibleWindow);
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
      expect.stringMatching(
        /dateDiff\('millisecond', parseDateTime64BestEffort\(\{startedAt:String\}, 3, 'UTC'\), sensor\.recorded_at\)/,
      ),
      {
        userId: "user",
        activityIds: [activityId],
        channels: ["power"],
        startedAt: "2026-06-15T00:00:00.000Z",
      },
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

  describe("exact fractional lap bounds", () => {
    const at = (seconds: number) =>
      new Date(Date.parse("2026-06-15T00:00:00.000Z") + seconds * 1_000).toISOString();
    const fractional = (index: number, from: number, to: number) =>
      row({
        interval_index: index,
        started_at: at(from),
        ended_at: at(to),
        target_power_min_watts: null,
        target_power_max_watts: null,
        target_power_watts: 250,
        recorded_timer_duration_seconds: null,
      });
    // Power equals ten times the second plus ten: t=0 -> 10, t=1 -> 20, t=2 -> 30, t=3 -> 40.
    const ramp = Array.from({ length: 5 }, (_, second) => sample(second, 10 + 10 * second));

    it("includes the last timestamp before an exact end and keeps exact offsets", async () => {
      const { result } = run([fractional(0, 0, 2.4)], ramp);
      const [only] = await result;

      expect(only).toMatchObject({
        startOffsetSeconds: 0,
        endOffsetSeconds: 2.4,
        averagePowerWatts: 20,
      });
    });

    it("keeps the last timestamp when the canonical window itself ends at 2.4 s", async () => {
      const { result } = run([fractional(0, 0, 3)], ramp, {
        ...window,
        endedAt: "2026-06-15 00:00:02.4+00",
      });

      expect(await result).toEqual([
        expect.objectContaining({ endOffsetSeconds: 3, averagePowerWatts: 20 }),
      ]);
    });

    it("serves a lap that starts before the canonical start with a signed exact offset", async () => {
      const { result } = run([fractional(0, -1.5, 2.4)], ramp);

      expect(await result).toEqual([
        expect.objectContaining({
          startOffsetSeconds: -1.5,
          endOffsetSeconds: 2.4,
          averagePowerWatts: 20,
        }),
      ]);
    });

    it("partitions touching fractional laps and keeps a window without a timestamp as null power", async () => {
      const { result } = run(
        [fractional(0, 0, 2.4), fractional(1, 2.4, 3.5), fractional(2, 3.5, 3.9)],
        ramp,
      );
      const laps = await result;

      expect(laps.map((lapResult) => lapResult.averagePowerWatts)).toEqual([20, 40, null]);
      expect(
        laps.map((lapResult) => [lapResult.startOffsetSeconds, lapResult.endOffsetSeconds]),
      ).toEqual([
        [0, 2.4],
        [2.4, 3.5],
        [3.5, 3.9],
      ]);
    });
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

describe("evidence stays linked to distinct exact windows sharing selected buckets", () => {
  const at = (seconds: number) =>
    new Date(Date.parse("2026-06-15T00:00:00.000Z") + seconds * 1_000).toISOString();
  const point = (watts: number) => ({
    target_power_min_watts: null,
    target_power_max_watts: null,
    target_power_watts: watts,
  });

  it("attaches each plan to its own lap", async () => {
    const intervals = recordedIntervalsForActivity(activity, [
      row({ ...point(200), ended_at: at(179.1) }),
      row({ ...point(300), member_activity_id: activityId, ended_at: at(179.2) }),
    ]);
    const samples = Array.from({ length: 360 }, (_, second) => ({
      elapsedSeconds: second,
      powerWatts: 200,
    }));
    const prepared = prepareCyclingEffortMetrics(samples, {
      durationSeconds: 360,
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

    expect(
      effort?.intervals.map((interval) =>
        interval.evidence?.plan?.target.kind === "point"
          ? interval.evidence.plan.target.watts
          : null,
      ),
    ).toEqual([200, 300]);
  });
});
