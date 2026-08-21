import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { InsightsRepository } from "./insights-repository.ts";

vi.mock("../insights/engine.ts", () => ({
  computeInsights: vi.fn().mockReturnValue([]),
}));

function makeDb() {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([]) // sleep
    .mockResolvedValueOnce([]) // activities
    .mockResolvedValueOnce([]) // nutrition
    .mockResolvedValueOnce([]); // bodyComp
  return { execute };
}

function makeSensorStore(): Pick<ActivitySensorStore, "query"> {
  return {
    query: vi.fn().mockResolvedValue([]),
  };
}

describe("InsightsRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("computeInsights", () => {
    it("executes Postgres queries only for non-vitals datasets", async () => {
      const db = makeDb();
      const sensorStore = makeSensorStore();
      const repo = new InsightsRepository(db, "user-1", "UTC", sensorStore);
      await repo.computeInsights(90, "2024-06-01");
      expect(db.execute).toHaveBeenCalledTimes(2);
      expect(sensorStore.query).toHaveBeenCalledTimes(4);
    });

    it("returns engine result for empty data", async () => {
      const db = makeDb();
      const repo = new InsightsRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.computeInsights(90, "2024-06-01");
      expect(result).toEqual([]);
    });

    it("passes parsed rows to computeInsights engine", async () => {
      const { computeInsights } = await import("../insights/engine.ts");
      const db = makeDb();
      const repo = new InsightsRepository(db, "user-1", "UTC", makeSensorStore());
      await repo.computeInsights(30, "2024-06-01");
      expect(computeInsights).toHaveBeenCalledWith([], [], [], [], []);
    });

    it("passes ClickHouse resting heart rate rows into same-date daily metrics", async () => {
      const { computeInsights } = await import("../insights/engine.ts");
      const db = makeDb();
      const sensorStore: Pick<ActivitySensorStore, "query"> = {
        query: vi
          .fn()
          .mockResolvedValueOnce([
            {
              date: "2024-05-30",
              resting_hr: null,
              hrv: 62,
              spo2_avg: 98,
              steps: 8_000,
              skin_temp_c: 33.2,
            },
            {
              date: "2024-05-31",
              resting_hr: null,
              hrv: 58,
              spo2_avg: 97,
              steps: 6_500,
              skin_temp_c: 33.4,
            },
          ])
          .mockResolvedValueOnce([
            { date: "2024-05-30", resting_hr: 48 },
            { date: "2024-06-01", resting_hr: 51 },
          ])
          .mockResolvedValue([]),
      };
      const repo = new InsightsRepository(db, "user-1", "UTC", sensorStore);

      await repo.computeInsights(30, "2024-06-01");

      expect(computeInsights).toHaveBeenCalledWith(
        [
          {
            date: "2024-05-30",
            resting_hr: 48,
            hrv: 62,
            spo2_avg: 98,
            steps: 8_000,
            skin_temp_c: 33.2,
          },
          {
            date: "2024-05-31",
            resting_hr: null,
            hrv: 58,
            spo2_avg: 97,
            steps: 6_500,
            skin_temp_c: 33.4,
          },
        ],
        [],
        [],
        [],
        [],
      );
    });

    it("queries precomputed resting heart rate windows for vitals", async () => {
      const db = makeDb();
      const sensorStore = makeSensorStore();
      const repo = new InsightsRepository(db, "user-1", "UTC", sensorStore);
      await repo.computeInsights(30, "2024-06-01");

      const vitalsQuery = String(vi.mocked(sensorStore.query).mock.calls[0]?.[1]);
      const restingHeartRateQuery = String(vi.mocked(sensorStore.query).mock.calls[1]?.[1]);
      expect(vitalsQuery).toContain("analytics.v_daily_metrics");
      expect(vitalsQuery).not.toContain("derived_resting_heart_rate");
      expect(restingHeartRateQuery).toContain("analytics.resting_heart_rate_sleep_window");
      expect(restingHeartRateQuery).not.toContain("analytics.deduped_sensor");
      expect(restingHeartRateQuery).not.toContain("derived_resting_heart_rate");
    });
  });
});
