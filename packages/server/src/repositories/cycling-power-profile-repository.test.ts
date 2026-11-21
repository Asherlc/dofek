import { describe, expect, it, vi } from "vitest";
import type { AccessWindow } from "../billing/entitlement.ts";
import { CyclingPowerProfileRepository } from "./cycling-power-profile-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const rideId = "00000000-0000-4000-8000-000000000010";
const weightId = "00000000-0000-4000-8000-000000000020";
const settingsId = "00000000-0000-4000-8000-000000000030";
const range = { startDate: "2026-10-01", endDate: "2026-10-31" };
const timezone = "America/Los_Angeles";
const fiveMinuteEffort = {
  activity_id: rideId,
  activity_name: "Hill repeats",
  modality: "road",
  activity_date: "2026-10-31",
  started_at: "2026-10-31T15:00:00.000Z",
  canonical_type: "cycling",
  duration_seconds: 300,
  best_power: 336,
  start_offset_seconds: 2480,
  observed_samples: 301,
  median_sample_interval_seconds: 1,
  largest_gap_seconds: 1,
  coverage_pct: 100,
  power_measurement_kind: "unknown",
  source_providers: ["fit-file"],
  source_devices: [],
  member_activity_ids: [rideId],
};

function fixture(
  ftp: number | null,
  withWeight: boolean,
  options?: { efforts?: readonly unknown[]; accessWindow?: AccessWindow },
) {
  const queries: Array<{ sql: string; params: Record<string, unknown> | undefined }> = [];
  const repository = new CyclingPowerProfileRepository(
    {
      execute: vi.fn().mockResolvedValue([
        {
          id: settingsId,
          user_id: userId,
          sport: "cycling",
          ftp,
          threshold_hr: null,
          threshold_pace_per_km: null,
          power_zone_pcts: null,
          hr_zone_pcts: null,
          pace_zone_pcts: null,
          effective_from: "2026-10-12",
          notes: null,
          created_at: "2026-10-12T08:00:00.000Z",
          updated_at: "2026-10-12T08:00:00.000Z",
        },
      ]),
    },
    {
      query: vi.fn(async (schema, sql, params) => {
        queries.push({ sql, params });
        const rows = sql.includes("nearby-weight:observations")
          ? withWeight
            ? [
                {
                  date: "2026-10-31",
                  recorded_at: "2026-10-31T08:00:00.000Z",
                  weight_kg: 72,
                  provider_id: "withings",
                  external_id: null,
                  record_id: weightId,
                },
              ]
            : []
          : (options?.efforts ?? [fiveMinuteEffort]);
        return rows.map((row) => schema.parse(row));
      }),
    },
    userId,
    timezone,
    options?.accessWindow,
  );
  return { repository, queries };
}

describe("CyclingPowerProfileRepository", () => {
  it("returns the four points with record references and unverified test status", async () => {
    const { repository, queries } = fixture(288, true);
    const result = await repository.read(range);
    expect(queries[0]?.sql).toContain(
      "AND toDate(toTimeZone(activity.started_at, {timezone:String})) >= toDate({startDate:String})",
    );
    expect(queries[0]?.params).toEqual({ userId, timezone, durations: [5, 60, 300], ...range });
    expect(result.range).toEqual({
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      timezone: "America/Los_Angeles",
    });
    expect(result.maximal_test_status).toBe("unverified");
    expect(result.efforts).toEqual([
      { duration_seconds: 5, effort: null },
      { duration_seconds: 60, effort: null },
      {
        duration_seconds: 300,
        effort: expect.objectContaining({
          activity_id: rideId,
          activity_name: "Hill repeats",
          date: "2026-10-31",
          start_offset_seconds: 2480,
          end_offset_seconds: 2780,
          watts: 336,
          watts_per_kg: 4.667,
          power_kind: "unknown",
          weight: expect.objectContaining({
            value_kg: 72,
            sources: [expect.objectContaining({ record_id: weightId, provider: "withings" })],
          }),
        }),
      },
    ]);
    expect(result.threshold).toMatchObject({
      watts: 288,
      watts_per_kg: 4,
      effective_from: "2026-10-12",
      source_record_id: settingsId,
      method: "configured",
      unavailable_reason: null,
    });
  });

  it("preserves ride watts when weight is absent and honors a cleared FTP", async () => {
    const result = await fixture(null, false).repository.read(range);
    expect(result.efforts[2]?.effort).toMatchObject({
      watts: 336,
      watts_per_kg: null,
      weight: { value_kg: null, reason: expect.any(String) },
    });
    expect(result.threshold).toMatchObject({
      watts: null,
      watts_per_kg: null,
      effective_from: "2026-10-12",
      unavailable_reason: expect.any(String),
    });
  });

  it("reads only threshold evidence on all time when there are no rides", async () => {
    const { repository, queries } = fixture(288, true, { efforts: [] });

    const result = await repository.read({ startDate: null, endDate: range.endDate });

    expect(queries[0]?.sql).not.toContain("{startDate:String}");
    expect(queries[0]?.params).toStrictEqual({
      userId,
      timezone,
      durations: [5, 60, 300],
      endDate: range.endDate,
    });
    expect(queries[1]?.params).toEqual({
      userId,
      timezone,
      startDate: range.endDate,
      endDate: range.endDate,
    });
    expect(result.threshold).toMatchObject({ watts: 288, watts_per_kg: 4 });
  });

  it("bounds qualifying ride and weight evidence and keeps an unknown elapsed time unknown", async () => {
    const earlierEffort = {
      ...fiveMinuteEffort,
      activity_date: "2026-10-25",
      started_at: "2026-10-25T15:00:00.000Z",
      duration_seconds: 5,
      start_offset_seconds: null,
    };
    const { repository, queries } = fixture(null, true, {
      efforts: [earlierEffort, fiveMinuteEffort],
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-10-25",
        endDateExclusive: "2026-11-01",
      },
    });

    const result = await repository.read(range);

    const accessParams = {
      accessStartDate: "2026-10-25",
      accessEndDateExclusive: "2026-11-01",
      accessTimezone: timezone,
    };
    expect(queries[0]?.params).toMatchObject(accessParams);
    expect(queries[1]?.sql).toContain("toString(body.id) AS record_id");
    expect(queries[1]?.params).toEqual({
      userId,
      timezone,
      startDate: "2026-10-25",
      endDate: range.endDate,
      ...accessParams,
    });
    expect(result.efforts[0]?.effort).toMatchObject({
      date: "2026-10-25",
      start_offset_seconds: null,
      end_offset_seconds: null,
    });
    expect(result.threshold).toMatchObject({ watts: null, weight: null });
  });

  it("skips weight when both ride power and FTP are unavailable", async () => {
    const { repository, queries } = fixture(null, false, { efforts: [] });

    await repository.read(range);

    expect(queries).toHaveLength(1);
  });

  it("keeps configured FTP in watts when no nearby weight is available", async () => {
    const { repository } = fixture(288, false);

    const result = await repository.read(range);

    expect(result.threshold).toMatchObject({ watts: 288, watts_per_kg: null });
  });
});
