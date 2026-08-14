import { describe, expect, it, vi } from "vitest";
import {
  type AnalyticsMicrobatchQueryClient,
  resolveAnalyticsMicrobatchBounds,
} from "./analytics-microbatch-bounds.ts";

function clickHouseWithRows(
  rows: readonly { scalar_begin: string | null; location_begin: string | null }[],
): AnalyticsMicrobatchQueryClient {
  return {
    query: vi.fn(async () => ({
      json: async () => structuredClone(rows),
    })),
  };
}

describe("resolveAnalyticsMicrobatchBounds", () => {
  it("uses the earliest relevant scalar and location source dates", async () => {
    const clickHouse = clickHouseWithRows([
      {
        scalar_begin: "2025-02-03",
        location_begin: "2025-04-05",
      },
    ]);

    await expect(
      resolveAnalyticsMicrobatchBounds(clickHouse, new Date("2026-07-24T12:34:56.000Z")),
    ).resolves.toEqual({
      sensor_scalar_sample_begin: "2025-02-03",
      deduped_sensor_begin: "2025-02-03",
      activity_sensor_sample_begin: "2025-02-03",
      activity_location_sample_begin: "2025-04-05",
    });

    expect(clickHouse.query).toHaveBeenCalledOnce();
    expect(clickHouse.query).toHaveBeenCalledWith({
      query: expect.stringContaining("FROM ingest.metric_stream"),
      format: "JSONEachRow",
    });
  });

  it("uses the current UTC day for empty source groups", async () => {
    const clickHouse = clickHouseWithRows([
      {
        scalar_begin: null,
        location_begin: null,
      },
    ]);

    await expect(
      resolveAnalyticsMicrobatchBounds(clickHouse, new Date("2026-07-24T23:59:59.000Z")),
    ).resolves.toEqual({
      sensor_scalar_sample_begin: "2026-07-24",
      deduped_sensor_begin: "2026-07-24",
      activity_sensor_sample_begin: "2026-07-24",
      activity_location_sample_begin: "2026-07-24",
    });
  });

  it("falls back only for the source group that is empty", async () => {
    const clickHouse = clickHouseWithRows([
      {
        scalar_begin: "2025-06-07",
        location_begin: null,
      },
    ]);

    await expect(
      resolveAnalyticsMicrobatchBounds(clickHouse, new Date("2026-07-24T00:00:00.000Z")),
    ).resolves.toEqual({
      sensor_scalar_sample_begin: "2025-06-07",
      deduped_sensor_begin: "2025-06-07",
      activity_sensor_sample_begin: "2025-06-07",
      activity_location_sample_begin: "2026-07-24",
    });
  });
});
