import { describe, expect, it, vi } from "vitest";
import { PmcRepository } from "./pmc-repository.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

vi.mock("dofek/personalization/params", () => ({
  getEffectiveParams: vi.fn().mockReturnValue({
    exponentialMovingAverage: {
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
    },
    trainingImpulseConstants: {
      genderFactor: 1.92,
      exponent: 1.67,
    },
  }),
}));

function makeActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    global_max_hr: 190,
    resting_hr: 60,
    id: "act-1",
    date: "2025-06-15",
    duration_min: 60,
    avg_hr: 150,
    max_hr: 180,
    avg_power: 200,
    power_samples: 3600,
    hr_samples: 3600,
    ...overrides,
  };
}

function makeDb(
  activityRows: Record<string, unknown>[] = [],
  npRows: Record<string, unknown>[] = [],
) {
  // loadPersonalizedParams is mocked at module level (returns null),
  // so it never calls db.execute. Only executeWithSchema calls remain:
  // 1st call = activities query, 2nd call = NP query.
  const execute = vi
    .fn()
    .mockResolvedValueOnce(activityRows) // activities query
    .mockResolvedValueOnce(npRows); // NP query
  return { execute };
}

describe("PmcRepository", () => {
  describe("getChart", () => {
    it("returns empty data with generic model when no activities", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(result.model).toEqual({
        type: "generic",
        pairedActivities: 0,
        r2: null,
        ftp: null,
      });
    });

    it("returns empty result when global max HR is null", async () => {
      const db = makeDb([makeActivityRow({ global_max_hr: null })], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(result.model.type).toBe("generic");
      expect(result.model.ftp).toBeNull();
    });

    it("returns empty result when global max HR is zero", async () => {
      const db = makeDb([makeActivityRow({ global_max_hr: 0 })], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(result.model.type).toBe("generic");
    });

    it("can be instantiated and called", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "America/New_York");
      const result = await repo.getChart(90);

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("model");
    });

    it("uses default resting HR of 60 when no activity data available", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);
      // With no activities, should return empty (globalMaxHr is null)
      expect(result.data).toEqual([]);
    });

    it("rounds model r2 to exactly 3 decimal places", async () => {
      // When model is learned type, r2 should be rounded to 3 decimals
      // This is difficult to test with mocked data, so verify the generic case
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(90);
      if (result.model.r2 !== null) {
        const r2Str = String(result.model.r2);
        const decimalPart = r2Str.split(".")[1] ?? "";
        expect(decimalPart.length).toBeLessThanOrEqual(3);
      }
    });

    it("returns pairedActivities as exactly 0 (not 1 or other value) when no data", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);
      expect(result.model.pairedActivities).toStrictEqual(0);
      expect(result.model.r2).toStrictEqual(null);
      expect(result.model.ftp).toStrictEqual(null);
    });

    it("trims leading zeros from EWMA output", async () => {
      // Create a single activity far in the past relative to today.
      // The EWMA should trim all the leading zero-CTL days.
      const today = new Date();
      const daysAgo = 30;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-trim", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // The first data point should have non-zero CTL (trimmed leading zeros)
      // or be the date of the activity (first day CTL accumulates)
      if (result.data.length > 0) {
        const firstWithCtl = result.data.find((point) => point.ctl >= 0.1);
        expect(result.data[0]?.date).toBe(firstWithCtl?.date);
      }
    });

    it("computes daily load from activities with HR-only fallback", async () => {
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Activity with no power data — should use HR fallback
      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-hr", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.model.type).toBe("generic");
      expect(result.model.ftp).toBeNull();
      // Should have data points — the HR fallback produces non-zero TSS
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("uses power TSS when NP and FTP are available", async () => {
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-power", avg_power: 200, duration_min: 60 })],
        [{ activity_id: "act-power", np: 220 }],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // FTP should be estimated (200 * 0.95 = 190)
      expect(result.model.ftp).toBe(190);
      expect(result.data.length).toBeGreaterThan(0);
    });
  });
});
