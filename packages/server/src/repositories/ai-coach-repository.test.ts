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

    it("rounds sleepHours to 1 decimal (distinguishes 1 vs 2 decimal precision)", async () => {
      const db = makeDb([{ sleep_hours: 7.43, resting_hr: null, hrv: null, readiness: null }], []);
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      // 7.43 * 10 = 74.3, Math.round(74.3) = 74, /10 = 7.4
      // If mutated to * 100 / 100, result would be 7.43
      expect(context.sleepHours).toBe(7.4);
    });

    it("rounds duration_min to integer in activity label", async () => {
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: null, hrv: null, readiness: null }],
        [{ name: "Run", duration_min: 32.4 }],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      expect(context.recentActivities).toEqual(["Run 32min"]);
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

    it("filters require BOTH name AND duration (not OR)", async () => {
      // If filter used || instead of &&, activities with EITHER name or duration would pass
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: null, hrv: null, readiness: null }],
        [
          { name: null, duration_min: 30 },
          { name: "Yoga", duration_min: null },
        ],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      // With &&: both filtered out. With ||: both would pass.
      expect(context.recentActivities).toEqual([]);
    });

    it("uses != null check (not just truthy) for metrics", async () => {
      const db = makeDb(
        [{ sleep_hours: 0, resting_hr: 0, hrv: 0, readiness: 0 }],
        [],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      // 0 is falsy but != null, so these should be defined
      expect(context.sleepHours).toBe(0);
      expect(context.restingHr).toBe(0);
      expect(context.hrv).toBe(0);
      expect(context.readiness).toBe(0);
    });

    it("rounds restingHr to integer (not 1 decimal)", async () => {
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: 52.7, hrv: null, readiness: null }],
        [],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      expect(context.restingHr).toBe(53);
    });

    it("rounds hrv to integer (not 1 decimal)", async () => {
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: null, hrv: 68.3, readiness: null }],
        [],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      expect(context.hrv).toBe(68);
    });

    it("rounds readiness to integer", async () => {
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: null, hrv: null, readiness: 85.6 }],
        [],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      expect(context.readiness).toBe(86);
    });

    it("formats activity label as 'name Xmin'", async () => {
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: null, hrv: null, readiness: null }],
        [{ name: "Run", duration_min: 45 }],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      expect(context.recentActivities[0]).toBe("Run 45min");
    });

    it("returns undefined (not null) for absent metric values", async () => {
      const db = makeDb(
        [{ sleep_hours: null, resting_hr: null, hrv: null, readiness: null }],
        [],
      );
      const repo = new AiCoachRepository(db, "user-1");
      const context = await repo.fetchContext();
      expect(context.sleepHours).toBeUndefined();
      expect(context.restingHr).toBeUndefined();
      expect(context.hrv).toBeUndefined();
      expect(context.readiness).toBeUndefined();
    });
  });
});
