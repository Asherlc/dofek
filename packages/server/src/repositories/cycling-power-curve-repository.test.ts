import { describe, expect, it, vi } from "vitest";
import { CyclingPowerCurveRepository } from "./cycling-power-curve-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";

function curveRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: "00000000-0000-4000-8000-000000000010",
    activity_date: "2026-06-15",
    started_at: "2026-06-15T15:00:00.000Z",
    canonical_type: "cycling",
    duration_seconds: 1200,
    best_power: 300,
    start_offset_seconds: 420,
    observed_samples: 1201,
    median_sample_interval_seconds: 1,
    largest_gap_seconds: 1,
    coverage_pct: 100,
    power_measurement_kind: "direct",
    source_providers: ["wahoo"],
    source_devices: ["elemnt-bolt"],
    ...overrides,
  };
}

function customCurveRow(overrides: Record<string, unknown> = {}) {
  const row = curveRow(overrides);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [`result_${key}`, value]));
}

describe("CyclingPowerCurveRepository", () => {
  it("returns range bests and a stable activity-curve page with weight evidence", async () => {
    const rows = [
      curveRow({ duration_seconds: 300, best_power: 360, start_offset_seconds: 60 }),
      curveRow(),
      curveRow({
        activity_id: "00000000-0000-4000-8000-000000000011",
        activity_date: "2026-06-20",
        started_at: "2026-06-20T15:00:00.000Z",
        duration_seconds: 1800,
        best_power: 280,
      }),
      curveRow({
        activity_id: "00000000-0000-4000-8000-000000000012",
        activity_date: "2026-06-25",
        started_at: "2026-06-25T15:00:00.000Z",
        duration_seconds: 3600,
        best_power: 250,
      }),
    ];
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("power-curve:standard:bests")) return rows;
      if (queryText.includes("power-curve:standard:page")) return rows.slice(0, 3);
      if (queryText.includes("power-curve:weights")) {
        return [
          {
            date: "2026-06-10",
            recorded_at: "2026-06-10T08:00:00.000Z",
            weight_kg: 70,
            provider_id: "withings",
            external_id: "weight-before",
          },
          {
            date: "2026-06-20",
            recorded_at: "2026-06-20T08:00:00.000Z",
            weight_kg: 72,
            provider_id: "withings",
            external_id: "weight-after",
          },
        ];
      }
      return [];
    });
    const repository = new CyclingPowerCurveRepository({ query }, userId, "America/Los_Angeles");

    const result = await repository.listRange({
      startDate: "2026-03-01",
      endDate: "2026-08-28",
      durationsSeconds: [300, 1200, 1800, 3600],
      modalities: ["cycling", "indoor_cycling"],
      providers: ["wahoo"],
      includeActivityCurve: true,
      cursor: null,
      limit: 2,
    });

    expect(result.bests).toHaveLength(4);
    expect(result.bests[1]).toMatchObject({
      activity_id: "00000000-0000-4000-8000-000000000010",
      duration_seconds: 1200,
      power_kind: "direct",
      start_offset_seconds: 420,
      watts: 300,
      watts_per_kg: 4.225,
      weight: {
        kind: "interpolated",
        value_kg: 71,
      },
    });
    expect(result.activity_curve).toHaveLength(2);
    expect(result.next_cursor).toEqual(expect.any(String));

    const standardBestCall = query.mock.calls.find((call) =>
      String(call[1]).includes("power-curve:standard:bests"),
    );
    expect(standardBestCall?.[1]).toContain(
      "FROM analytics.activity_power_curve AS power_curve FINAL",
    );
    expect(standardBestCall?.[1]).toContain("INNER JOIN analytics.deduped_activities");
    expect(standardBestCall?.[1]).toContain("hasAny(activity.source_providers");
    expect(standardBestCall?.[2]).toMatchObject({
      durations: [300, 1200, 1800, 3600],
      providers: ["wahoo"],
      startDate: "2026-03-01",
      endDate: "2026-08-28",
      userId,
    });
  });

  it("uses a bounded deduped-sample calculation for arbitrary durations", async () => {
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("power-curve:custom:bests")) {
        return [customCurveRow({ duration_seconds: 421, best_power: 315 })];
      }
      return [];
    });
    const repository = new CyclingPowerCurveRepository({ query }, userId, "UTC");

    const result = await repository.listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      durationsSeconds: [421],
      modalities: ["cycling"],
      providers: [],
      includeActivityCurve: false,
      cursor: null,
      limit: 50,
    });

    expect(result.bests[0]).toMatchObject({
      duration_seconds: 421,
      watts: 315,
      watts_per_kg: null,
      watts_per_kg_reason: "No valid positive directly measured body weight is available",
    });
    const customCall = query.mock.calls.find((call) =>
      String(call[1]).includes("power-curve:custom:bests"),
    );
    expect(customCall?.[1]).toContain("analytics.activity_sensor_sample AS sensor FINAL");
    expect(customCall?.[1]).toContain("sensor.scalar >= 0");
    expect(customCall?.[1]).toContain("ASOF INNER JOIN power_sample_endpoints");
    expect(customCall?.[1]).toContain("duration_values.duration_seconds >=");
    expect(customCall?.[2]).toMatchObject({ durations: [421] });
  });

  it("rejects excessive duration requests before querying", async () => {
    const query = vi.fn();
    const repository = new CyclingPowerCurveRepository({ query }, userId, "UTC");

    await expect(
      repository.listRange({
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        durationsSeconds: Array.from({ length: 33 }, (_, index) => index + 1),
        modalities: ["cycling"],
        providers: [],
        includeActivityCurve: false,
        cursor: null,
        limit: 50,
      }),
    ).rejects.toThrow("At most 32 power-curve durations may be requested");
    expect(query).not.toHaveBeenCalled();
  });
});
