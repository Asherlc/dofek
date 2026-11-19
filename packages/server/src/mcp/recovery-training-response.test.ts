import { describe, expect, it } from "vitest";
import { formatSeriesPage } from "./recovery-training-response.ts";

type Row = Parameters<typeof formatSeriesPage>[0][number];
type Sleep = Extract<Row["sleep"], { status: "observed" }>;
type Activity = Extract<Row["activity_exposure"], { coverage_status: string }>;

function sleep(date: string, sourceName: string): Sleep {
  return {
    status: "observed",
    selected_session_id: date,
    source_session_ids: [date],
    source_providers: ["whoop"],
    source_provider: "whoop",
    source_name: sourceName,
    started_at: `${date}T01:00:00Z`,
    ended_at: `${date}T08:00:00Z`,
    local_start_date: date,
    local_start_time: "01:00:00",
    local_wake_date: date,
    local_wake_time: "08:00:00",
    display_timezone: "UTC",
    timezone_source: "caller",
    local_time_context: {
      timezone: null,
      start_utc_offset_minutes: null,
      end_utc_offset_minutes: null,
      source: "unknown",
    },
    is_nap: false,
    sleep_kind_recorded: true,
    elapsed_minutes: 420,
    duration_minutes: 400,
    efficiency_pct: null,
    stages_minutes: { deep: null, light: null, rem: null, awake: 20 },
    staging_available: false,
    missing_fields: ["efficiency_pct", "stages_minutes"],
  };
}

function workout(localEndTime: string): Activity {
  return {
    coverage_status: "observed",
    reason: null,
    previous_wake: { session_id: "prior-night", ended_at: "2026-11-11T07:00:00Z" },
    activity_count: 1,
    source_activity_ids: ["run"],
    source_activity_ids_truncated: false,
    source_providers: ["garmin"],
    duration: { value_minutes: 60, supported_activities: 1 },
    last_activity: {
      id: "run",
      canonical_type: "running",
      ended_at: `2026-11-11T${localEndTime}Z`,
      local_end_date: "2026-11-11",
      local_end_time: localEndTime,
      source_providers: ["garmin"],
    },
    minutes_to_sleep: 90,
  };
}

describe("formatSeriesPage", () => {
  it("counts recorded zero and partial load while omitting unobserved days", () => {
    function load(status: "available" | "partial" | "not_observed") {
      const channel = {
        daily_value: 0,
        unit: "points",
        value_kind: "calculated" as const,
        status,
        reason: null,
        source_activity_ids: [],
        source_providers: [],
        coverage: {
          contributing_records: 0,
          supported_records: 0,
          first_observed_date: null,
          source_activity_count: 0,
          source_activity_ids_truncated: false,
        },
        context: {},
        date_attribution: { authoritative_activities: 0, analysis_timezone_activities: 0 },
        rolling: {
          acute_7d_sum: null,
          chronic_28d_weekly_equivalent: null,
          workload_ratio: null,
          monotony_7d: null,
          strain_7d: null,
          acute_coverage_days: 0,
          chronic_coverage_days: 0,
          unavailable_reasons: [],
        },
      };
      return {
        cycling_power_tss: channel,
        heart_rate_zone_load: channel,
        session_rpe: channel,
        climbing_attempts: channel,
        finger_load: channel,
        strength_volume: channel,
      };
    }
    const result = formatSeriesPage(
      [
        {
          date: "2026-11-19",
          training_load: load("not_observed"),
          previous_day_training_load: load("available"),
        },
        {
          date: "2026-11-20",
          training_load: load("partial"),
          previous_day_training_load: load("not_observed"),
        },
      ],
      ["training_load", "previous_day_training_load"],
      {},
    );

    expect(result.observed_counts).toEqual({ training_load: 1, previous_day_training_load: 1 });
  });

  it("counts workout finishes and sleep observations across all eligible pages", () => {
    const before = "2026-11-12";
    const late = "2026-11-19";
    const unknown = "2026-11-26";
    const rows: Row[] = [
      {
        date: before,
        row_id: "early-night",
        sleep_episode_ids: ["early-source"],
        sleep: sleep(before, "WHOOP 4.0"),
        activity_exposure: workout("19:59:59"),
      },
      {
        date: late,
        row_id: "late-night",
        sleep: sleep(late, "WHOOP 5.0"),
        activity_exposure: workout("20:00:00"),
      },
      {
        date: unknown,
        row_id: "missing-wake",
        sleep: { ...sleep(unknown, "WHOOP 5.0"), ended_at: null, duration_minutes: null },
        activity_exposure: {
          ...workout("21:00:00"),
          coverage_status: "partial",
          duration: { value_minutes: null, supported_activities: 0 },
          last_activity: null,
        },
      },
    ];
    const fields = ["sleep", "activity_exposure"] as const;
    const options = { limit: 1, workoutFinishAfter: "20:00:00" };

    const first = formatSeriesPage(rows, fields, options);
    expect(first.rows).toEqual([{ ...rows[0], weekday: "Thursday" }]);
    expect(first.next_cursor).toBe("early-night");
    expect(first.eligible_count).toBe(3);
    expect(first.observed_counts).toEqual({
      sleep: 3,
      "sleep.started_at": 3,
      "sleep.ended_at": 2,
      "sleep.duration_minutes": 2,
      "sleep.awake_minutes": 3,
      activity_exposure: 3,
      "activity_exposure.duration": 2,
      "activity_exposure.last_activity": 2,
    });
    expect(first.workout_finish_counts).toEqual([
      { weekday: "Thursday", before: 1, at_or_after: 1, unknown: 1 },
    ]);
    expect(first.sleep_source_changes).toEqual([
      {
        previous_date: before,
        date: late,
        previous_provider: "whoop",
        provider: "whoop",
        previous_source_name: "WHOOP 4.0",
        source_name: "WHOOP 5.0",
      },
    ]);
    const last = formatSeriesPage(rows, fields, { ...options, cursor: "late-night" });
    expect(last.rows.map(({ row_id }) => row_id)).toEqual(["missing-wake"]);
    expect(last.next_cursor).toBeNull();
    expect(last.workout_finish_counts).toEqual(first.workout_finish_counts);
  });

  it("keeps unselected stream fields and their counts out of date-only pages", () => {
    const date = "2026-11-19";
    const result = formatSeriesPage(
      [{ date, sleep: sleep(date, "WHOOP"), sleep_episode_ids: ["source"] }],
      ["body_weight", "nutrition"],
      {},
    );

    expect(result).toEqual({
      rows: [{ date, weekday: "Thursday" }],
      eligible_count: 1,
      observed_counts: { body_weight: 0, nutrition: 0 },
      next_cursor: null,
    });
    expect(() => formatSeriesPage([{ date }], [], { cursor: "missing" })).toThrow(
      "The cursor does not match this series",
    );
  });
});
