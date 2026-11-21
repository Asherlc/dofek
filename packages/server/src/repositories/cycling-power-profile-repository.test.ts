import { describe, expect, it, vi } from "vitest";
import { CyclingPowerProfileRepository } from "./cycling-power-profile-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const rideId = "00000000-0000-4000-8000-000000000010";
const weightId = "00000000-0000-4000-8000-000000000020";
const settingsId = "00000000-0000-4000-8000-000000000030";
const range = { startDate: "2026-10-01", endDate: "2026-10-31" };

function repository(ftp: number | null, withWeight: boolean) {
  return new CyclingPowerProfileRepository(
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
      query: vi.fn(async (schema, sql: string) => {
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
          : [
              {
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
              },
            ];
        return rows.map((row) => schema.parse(row));
      }),
    },
    userId,
    "America/Los_Angeles",
  );
}

describe("CyclingPowerProfileRepository", () => {
  it("returns the four points with record references and unverified test status", async () => {
    const result = await repository(288, true).read(range);
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
    });
  });

  it("preserves ride watts when weight is absent and honors a cleared FTP", async () => {
    const result = await repository(null, false).read(range);
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
});
