import { describe, expect, it } from "vitest";
import { recordedIntervalsForActivity } from "./cycling-effort-metrics.ts";

const activityA = "00000000-0000-4000-8000-000000000001";

function intervalRow(
  overrides: Partial<Parameters<typeof recordedIntervalsForActivity>[1][number]> = {},
): Parameters<typeof recordedIntervalsForActivity>[1][number] {
  return {
    member_activity_id: activityA,
    interval_index: 1,
    label: "work",
    interval_type: "work",
    started_at: "2026-06-15T00:00:00.000Z",
    ended_at: "2026-06-15T00:00:30.000Z",
    source_kind: "provider_recorded",
    source_provider: "provider-a",
    source_activity_id: activityA,
    segment_type: null,
    target_intensity: 0.9,
    target_zone: 4,
    target_cadence_rpm: 90,
    target_power_watts: 200,
    target_resistance: 50,
    work_recovery_kind: "work",
    raw: { stable: true },
    fit_source: null,
    planned_duration_seconds: null,
    recorded_timer_duration_seconds: null,
    target_power_min_watts: null,
    target_power_max_watts: null,
    ...overrides,
  };
}

describe("planned facts", () => {
  const activity = {
    activity_id: activityA,
    member_activity_ids: [activityA],
    started_at: "2026-06-15T00:00:00.000Z",
  };
  const planned = {
    fit_source: "workout_step_lap" as const,
    source_kind: "provider_recorded" as const,
    planned_duration_seconds: 30,
    recorded_timer_duration_seconds: 28,
    target_power_min_watts: 190,
    target_power_max_watts: 210,
    target_power_watts: null,
    started_at: "2026-06-15T00:00:00.250Z",
    ended_at: "2026-06-15T00:00:30.750Z",
  };
  const planOf = (overrides: Parameters<typeof intervalRow>[0]) =>
    recordedIntervalsForActivity(activity, [intervalRow({ ...planned, ...overrides })])[0]?.interval
      .plan;

  it("reads a range target with its planned and recorded timer durations and exact bounds", () => {
    const [result] = recordedIntervalsForActivity(activity, [intervalRow(planned)]);
    expect(result?.interval.plan).toEqual({
      fitSource: "workout_step_lap",
      target: { kind: "range", minWatts: 190, maxWatts: 210 },
      plannedDurationSeconds: 30,
      recordedTimerDurationSeconds: 28,
    });
    expect(result?.input).toMatchObject({ startOffsetSeconds: 0.25, endOffsetSeconds: 30.75 });
  });

  it("prefers a complete range over a point target and falls back to the point target", () => {
    expect(planOf({ target_power_watts: 250 })?.target).toEqual({
      kind: "range",
      minWatts: 190,
      maxWatts: 210,
    });
    for (const partialRange of [
      { target_power_min_watts: null },
      { target_power_max_watts: null },
      { target_power_min_watts: null, target_power_max_watts: null },
    ]) {
      expect(planOf({ ...partialRange, target_power_watts: 250 })?.target).toEqual({
        kind: "point",
        watts: 250,
      });
    }
  });

  it("supplies no plan when any required fact or every target is absent", () => {
    expect(planOf({ fit_source: null })).toBeUndefined();
    expect(planOf({ source_kind: null })).toBeUndefined();
    expect(planOf({ planned_duration_seconds: null })).toBeUndefined();
    expect(planOf({ target_power_min_watts: null })).toBeUndefined();
    expect(planOf({ target_power_max_watts: null })).toBeUndefined();
    expect(planOf({ target_power_min_watts: null, target_power_max_watts: null })).toBeUndefined();
  });

  it("keeps whole-second rounding for rows without a plan", () => {
    const [result] = recordedIntervalsForActivity(activity, [
      intervalRow({ ...planned, fit_source: null }),
    ]);
    expect(result?.input).toMatchObject({ startOffsetSeconds: 0, endOffsetSeconds: 31 });
  });
});
