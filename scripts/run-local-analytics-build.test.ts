import { describe, expect, it, vi } from "vitest";
import type { AnalyticsMicrobatchQueryClient } from "../src/processing/analytics-microbatch-bounds.ts";
import { runLocalAnalyticsBuild } from "./run-local-analytics-build.ts";

describe("runLocalAnalyticsBuild", () => {
  it("passes source-derived microbatch bounds to dbt", async () => {
    const clickHouse: AnalyticsMicrobatchQueryClient = {
      query: vi.fn(async () => ({
        json: async () => [
          {
            scalar_begin: "2025-02-03",
            location_begin: "2025-04-05",
          },
        ],
      })),
    };
    const runDbt = vi.fn(async () => 0);

    await expect(
      runLocalAnalyticsBuild({
        clickHouse,
        now: new Date("2026-07-24T12:34:56.000Z"),
        runDbt,
      }),
    ).resolves.toBeUndefined();

    expect(runDbt).toHaveBeenCalledWith([
      "run",
      "--project",
      "analytics",
      "dbt",
      "build",
      "--project-dir",
      "analytics",
      "--profiles-dir",
      "analytics",
      "--vars",
      '{"sensor_scalar_sample_begin":"2025-02-03","deduped_sensor_begin":"2025-02-03","activity_sensor_sample_begin":"2025-02-03","activity_location_sample_begin":"2025-04-05"}',
    ]);
  });

  it("fails when dbt exits unsuccessfully", async () => {
    const clickHouse: AnalyticsMicrobatchQueryClient = {
      query: vi.fn(async () => ({
        json: async () => [{ scalar_begin: null, location_begin: null }],
      })),
    };

    await expect(
      runLocalAnalyticsBuild({
        clickHouse,
        now: new Date("2026-07-24T12:34:56.000Z"),
        runDbt: async () => 2,
      }),
    ).rejects.toThrow("Local dbt build failed with exit code 2");
  });
});
