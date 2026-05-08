import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { DerivedCardioRepository } from "./derived-cardio-repository.ts";

function makeDb(rows: Record<string, unknown>[]) {
  return {
    execute: async () => rows,
  };
}

describe("DerivedCardioRepository", () => {
  it("averages VO2 max estimates returned by the sensor store", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("VO2 max should not query Postgres"));
    const sensorStore = {
      getVo2MaxEstimates: vi.fn().mockResolvedValue([
        {
          activity_id: "activity-1",
          activity_date: "2026-04-27",
          method: "cycling_power",
          vo2max: 40,
        },
        {
          activity_id: "activity-2",
          activity_date: "2026-04-28",
          method: "cycling_power",
          vo2max: 50,
        },
      ]),
    } satisfies Pick<ActivitySensorStore, "getVo2MaxEstimates">;
    const repo = new DerivedCardioRepository(
      { execute },
      {
        userId: "user-1",
        timezone: "America/Los_Angeles",
      },
      sensorStore,
    );

    const result = await repo.getVo2MaxAverage("2026-04-28", 90);

    expect(result?.value).toBe(45);
    expect(result?.sampleCount).toBe(2);
    expect(sensorStore.getVo2MaxEstimates).toHaveBeenCalledWith(
      "2026-04-28",
      90,
      "user-1",
      "America/Los_Angeles",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns null when no VO2 max estimates qualify", async () => {
    const sensorStore = {
      getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    } satisfies Pick<ActivitySensorStore, "getVo2MaxEstimates">;
    const repo = new DerivedCardioRepository(
      makeDb([]),
      {
        userId: "user-1",
        timezone: "America/Los_Angeles",
      },
      sensorStore,
    );

    await expect(repo.getVo2MaxAverage("2026-04-28", 90)).resolves.toBeNull();
  });

  it("counts only VO2 max estimates used in the average", async () => {
    const sensorStore = {
      getVo2MaxEstimates: vi.fn().mockResolvedValue([
        {
          activity_id: "activity-1",
          activity_date: "2026-04-27",
          method: "cycling_power",
          vo2max: 40,
        },
        {
          activity_id: "activity-2",
          activity_date: "2026-04-28",
          method: "cycling_power",
          vo2max: null,
        },
        {
          activity_id: "activity-3",
          activity_date: "2026-04-28",
          method: "cycling_power",
          vo2max: 0,
        },
      ]),
    } satisfies Pick<ActivitySensorStore, "getVo2MaxEstimates">;
    const repo = new DerivedCardioRepository(
      makeDb([]),
      {
        userId: "user-1",
        timezone: "America/Los_Angeles",
      },
      sensorStore,
    );

    await expect(repo.getVo2MaxAverage("2026-04-28", 90)).resolves.toEqual({
      value: 40,
      sampleCount: 1,
    });
  });

  it("maps resting HR rows from ClickHouse", async () => {
    const sensorStore = {
      query: vi.fn().mockResolvedValue([{ date: "2026-04-27", resting_hr: "52" }]),
    } satisfies Pick<ActivitySensorStore, "query">;
    const repo = new DerivedCardioRepository(
      makeDb([]),
      {
        userId: "user-1",
        timezone: "America/Los_Angeles",
      },
      sensorStore,
    );

    await expect(repo.getDailyRestingHeartRates("2026-04-28", 7)).resolves.toEqual([
      { date: "2026-04-27", restingHr: 52 },
    ]);
    expect(sensorStore.query).toHaveBeenCalledOnce();
  });
});
