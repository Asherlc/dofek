import { describe, expect, it, vi } from "vitest";
import { AiCoachRepository } from "./ai-coach-repository.ts";

function makeDb(
  metricsRows: Record<string, unknown>[] = [],
  activityRows: Record<string, unknown>[] = [],
) {
  const execute = vi.fn().mockResolvedValueOnce(metricsRows).mockResolvedValueOnce(activityRows);
  return { execute };
}

describe("AiCoachRepository", () => {
  describe("fetchContext", () => {
    it("returns empty context when no data", async () => {
      const db = makeDb([], []);
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();

      expect(context.sleepHours).toBeUndefined();
      expect(context.restingHr).toBeUndefined();
      expect(context.hrv).toBeUndefined();
      expect(context.readiness).toBeUndefined();
      expect(context.recentActivities).toEqual([]);
    });

    it("returns rounded metrics and formatted activities", async () => {
      const db = makeDb(
        [{ sleep_hours: 7.456, resting_hr: 52.3, hrv: 68.7, readiness: 85.2 }],
        [
          { name: "Morning Run", duration_min: 32.8 },
          { name: "Cycling", duration_min: 60.2 },
          { name: null, duration_min: 45 },
        ],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();

      expect(context.sleepHours).toBe(7.5);
      expect(context.restingHr).toBe(52);
      expect(context.hrv).toBe(69);
      expect(context.readiness).toBe(85);
      expect(context.recentActivities).toEqual(["Morning Run 33min", "Cycling 60min"]);
    });

    it("filters activities with null name or duration", async () => {
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: null, hrv: null, readiness: null }],
        [
          { name: null, duration_min: 30 },
          { name: "Yoga", duration_min: null },
          { name: "Swimming", duration_min: 45 },
        ],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();

      expect(context.recentActivities).toEqual(["Swimming 45min"]);
    });
  });
});
