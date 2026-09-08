import { describe, expect, it, vi } from "vitest";
import { AnalyticalTrainingLoadRepository } from "./analytical-training-load-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";

function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    throw new Error("Expected Drizzle SQL query object");
  }
  return JSON.stringify(Reflect.get(query, "queryChunks"));
}

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000100",
    user_id: userId,
    sport: "cycling",
    ftp: 250,
    threshold_hr: 175,
    threshold_pace_per_km: null,
    power_zone_pcts: [0.55, 0.75, 0.9, 1.05, 1.2, 1.5],
    hr_zone_pcts: [0.6, 0.7, 0.8, 0.9],
    pace_zone_pcts: null,
    effective_from: "2026-01-01",
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function dates(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date("2026-06-01T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

describe("AnalyticalTrainingLoadRepository", () => {
  it("returns a complete date spine with independent load channels and rolling definitions", async () => {
    const activityDates = dates(28);
    const execute = vi
      .fn()
      .mockResolvedValueOnce([settingsRow()])
      .mockResolvedValueOnce(
        activityDates.map((date, index) => ({
          date,
          session_rpe_source_providers: ["manual"],
          climbing_source_providers: ["kaya"],
          finger_source_providers: ["manual"],
          strength_source_providers: ["manual"],
          session_rpe_load: 300,
          session_rpe_activities: 1,
          session_rpe_supported_activities: 1,
          session_rpe_activity_ids: [
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          ],
          climbing_attempts: 10,
          climbing_entries: 4,
          climbing_entries_with_attempts: 4,
          climbing_session_minutes: 90,
          climbing_activity_ids: [`00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`],
          finger_load_kg_seconds: null,
          finger_entries: 1,
          finger_activity_ids: [`00000000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`],
          strength_volume_kg_reps: 500,
          strength_working_sets: 4,
          strength_suspicious_sets: 0,
          strength_activity_ids: [`00000000-0000-4000-8003-${String(index + 1).padStart(12, "0")}`],
          first_session_rpe_date: "2026-06-01",
          first_climbing_date: "2026-06-01",
          first_finger_date: "2026-06-01",
          first_strength_date: "2026-06-01",
        })),
      )
      .mockResolvedValueOnce([
        {
          first_session_rpe_date: "2026-06-01",
          first_climbing_date: "2026-06-01",
          first_finger_date: "2026-06-01",
          first_strength_date: "2026-06-01",
        },
      ]);
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("analytical-load:cycling")) {
        const finalWeekPower = [100, 150, 200, 250, 200, 150, 250];
        return activityDates.map((date, index) => ({
          activity_id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
          date,
          normalized_power: index < 21 ? 250 : (finalWeekPower[index - 21] ?? 250),
          elapsed_seconds: 3600,
          source_providers: ["wahoo"],
          first_observed_date: "2026-06-01",
        }));
      }
      if (queryText.includes("analytical-load:heart-rate")) {
        return activityDates.map((date, index) => ({
          date,
          load_points: 120,
          covered_seconds: 3600,
          activity_count: 1,
          activity_ids: [`00000000-0000-4000-9001-${String(index + 1).padStart(12, "0")}`],
          source_providers: ["wahoo"],
          first_observed_date: "2026-06-01",
        }));
      }
      return [];
    });
    const repository = new AnalyticalTrainingLoadRepository(
      { execute },
      { query },
      userId,
      "America/Los_Angeles",
    );

    const result = await repository.listRange("2026-06-28", "2026-06-28");

    expect(result).toMatchSnapshot();
    expect(execute.mock.calls.map(([query]) => queryText(query))).toMatchSnapshot();
    expect(
      query.mock.calls.map(([, clickHouseQuery, parameters]) => ({
        query: clickHouseQuery,
        parameters,
      })),
    ).toMatchSnapshot();
    expect(result.range).toEqual({
      start_date: "2026-06-28",
      end_date: "2026-06-28",
      timezone: "America/Los_Angeles",
      date_policy: "analysis_timezone",
    });
    expect(result.total_daily_load).toEqual({
      value: null,
      reason:
        "Modality-specific loads use different units and are not treated as biologically interchangeable.",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      date: "2026-06-28",
      channels: {
        cycling_power_tss: {
          daily_value: 100,
          unit: "TSS points",
          status: "available",
          rolling: {
            acute_7d_sum: 416,
            chronic_28d_weekly_equivalent: 629,
            workload_ratio: 0.661,
            monotony_7d: 1.978,
            strain_7d: 822.92,
            acute_coverage_days: 7,
            chronic_coverage_days: 28,
          },
        },
        heart_rate_zone_load: { daily_value: 120, unit: "weighted zone-minutes" },
        session_rpe: { daily_value: 300, unit: "RPE-minutes" },
        climbing_attempts: { daily_value: 10, unit: "attempts" },
        finger_load: {
          daily_value: null,
          unit: "kg-seconds",
          status: "unavailable",
          reason:
            "Exact finger-load volume requires repetitions per set, which the canonical source schema does not record.",
        },
        strength_volume: { daily_value: 500, unit: "kg-reps" },
      },
    });
    expect(result.rows[0]?.channels.climbing_attempts.context).toMatchObject({
      entries: 4,
      entries_with_attempt_data: 4,
      session_minutes: 90,
    });
    expect(result.rows[0]?.channels.strength_volume.context).toMatchObject({
      working_sets: 4,
      suspicious_sets_excluded: 0,
    });
    expect(result.rows[0]?.channels.cycling_power_tss.rolling.unavailable_reasons).toEqual([]);
  });

  it("does not turn unsupported activity load into zero", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          date: "2026-06-15",
          session_rpe_source_providers: [],
          climbing_source_providers: ["manual"],
          finger_source_providers: [],
          strength_source_providers: ["manual"],
          session_rpe_load: null,
          session_rpe_activities: 0,
          session_rpe_supported_activities: 0,
          session_rpe_activity_ids: [],
          climbing_attempts: null,
          climbing_entries: 2,
          climbing_entries_with_attempts: 0,
          climbing_session_minutes: 60,
          climbing_activity_ids: ["00000000-0000-4000-8001-000000000001"],
          finger_load_kg_seconds: null,
          finger_entries: 0,
          finger_activity_ids: [],
          strength_volume_kg_reps: null,
          strength_working_sets: 0,
          strength_suspicious_sets: 1,
          strength_activity_ids: ["00000000-0000-4000-8003-000000000001"],
          first_session_rpe_date: null,
          first_climbing_date: "2026-06-15",
          first_finger_date: null,
          first_strength_date: "2026-06-15",
        },
      ])
      .mockResolvedValueOnce([
        {
          first_session_rpe_date: null,
          first_climbing_date: "2026-06-15",
          first_finger_date: null,
          first_strength_date: "2026-06-15",
        },
      ]);
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("analytical-load:cycling")) {
        return [
          {
            activity_id: "00000000-0000-4000-9000-000000000001",
            date: "2026-06-15",
            normalized_power: 220,
            elapsed_seconds: 3600,
            source_providers: ["peloton"],
            first_observed_date: "2026-06-15",
          },
        ];
      }
      return [];
    });
    const repository = new AnalyticalTrainingLoadRepository({ execute }, { query }, userId, "UTC");

    const result = await repository.listRange("2026-06-14", "2026-06-15");

    expect(result).toMatchSnapshot();
    expect(result.rows[0]?.channels.cycling_power_tss).toMatchObject({
      daily_value: null,
      status: "unavailable",
      reason: "Source coverage had not begun by this date.",
    });
    expect(result.rows[0]?.channels.climbing_attempts).toMatchObject({
      daily_value: null,
      status: "unavailable",
      reason: "Source coverage had not begun by this date.",
    });

    expect(result.rows[1]?.channels.cycling_power_tss).toMatchObject({
      daily_value: null,
      status: "unavailable",
      reason: "No valid FTP was effective for 1 cycling activity.",
    });
    expect(result.rows[1]?.channels.climbing_attempts).toMatchObject({
      daily_value: null,
      status: "unavailable",
      reason: "Attempt information is missing for all 2 climbing entries.",
    });
    expect(result.rows[1]?.channels.strength_volume).toMatchObject({
      daily_value: null,
      status: "unavailable",
      reason: "All 1 strength sets were excluded by validation rules.",
    });
  });

  it("uses settings effective on the activity date and rejects nonascending HR zones", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        settingsRow({
          id: "00000000-0000-4000-8000-000000000102",
          effective_from: "2026-06-16",
          ftp: 300,
        }),
        settingsRow({
          id: "00000000-0000-4000-8000-000000000101",
          effective_from: "2026-06-15",
          ftp: 200,
          hr_zone_pcts: [0.6, 0.6, 0.8],
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          first_session_rpe_date: null,
          first_climbing_date: null,
          first_finger_date: null,
          first_strength_date: null,
        },
      ]);
    const query = vi.fn(async (_schema, clickHouseQuery: string) =>
      clickHouseQuery.includes("analytical-load:cycling")
        ? [
            {
              activity_id: "00000000-0000-4000-9000-000000000001",
              date: "2026-06-15",
              normalized_power: 200,
              elapsed_seconds: 3600,
              source_providers: ["wahoo"],
              first_observed_date: "2026-06-15",
              date_was_authoritative: true,
            },
          ]
        : [],
    );
    const result = await new AnalyticalTrainingLoadRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange("2026-06-15", "2026-06-15");

    expect(result).toMatchSnapshot();
    expect(result.rows[0]?.channels.cycling_power_tss.daily_value).toBe(100);
    expect(
      query.mock.calls.some(([, clickHouseQuery]) =>
        String(clickHouseQuery).includes("analytical-load:heart-rate"),
      ),
    ).toBe(false);
  });

  it("applies provider and modality filters to cycling and heart-rate source queries", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([settingsRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          first_session_rpe_date: null,
          first_climbing_date: null,
          first_finger_date: null,
          first_strength_date: null,
        },
      ]);
    const query = vi.fn().mockResolvedValue([]);
    const repository = new AnalyticalTrainingLoadRepository({ execute }, { query }, userId, "UTC");

    const result = await repository.listRange("2026-06-01", "2026-06-01", {
      providers: ["peloton"],
      modalities: ["indoor"],
    });

    expect(result).toMatchSnapshot();
    expect(execute.mock.calls.map(([query]) => queryText(query))).toMatchSnapshot();
    expect(
      query.mock.calls.map(([, clickHouseQuery, parameters]) => ({
        query: clickHouseQuery,
        parameters,
      })),
    ).toMatchSnapshot();

    const cyclingCall = query.mock.calls.find((call) =>
      String(call[1]).includes("analytical-load:cycling"),
    );
    const heartRateCall = query.mock.calls.find((call) =>
      String(call[1]).includes("analytical-load:heart-rate"),
    );
    expect(cyclingCall?.[1]).toContain("hasAny(activity.source_providers");
    expect(cyclingCall?.[2]).toMatchObject({ providers: ["peloton"], modalities: ["indoor"] });
    expect(heartRateCall?.[1]).toContain("has({modalities:Array(String)}, activity.modality)");
    expect(heartRateCall?.[2]).toMatchObject({ providers: ["peloton"], modalities: ["indoor"] });
  });

  it("caps per-channel activity ID evidence while retaining the total count", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([settingsRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          first_session_rpe_date: null,
          first_climbing_date: null,
          first_finger_date: null,
          first_strength_date: null,
        },
      ]);
    const cyclingRows = Array.from({ length: 105 }, (_, index) => ({
      activity_id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
      date: "2026-06-01",
      normalized_power: 250,
      elapsed_seconds: 3600,
      source_providers: ["wahoo"],
      first_observed_date: "2026-06-01",
      date_was_authoritative: true,
    }));
    const query = vi.fn(async (_schema, queryText: string) =>
      queryText.includes("analytical-load:cycling") ? cyclingRows : [],
    );

    const result = await new AnalyticalTrainingLoadRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange("2026-06-01", "2026-06-01", { providers: [], modalities: [] }, "source_context");

    expect(result).toMatchSnapshot();
    const channel = result.rows[0]?.channels.cycling_power_tss;
    expect(channel?.source_activity_ids).toHaveLength(100);
    expect(channel?.coverage).toMatchObject({
      source_activity_count: 105,
      source_activity_ids_truncated: true,
    });
  });
});
