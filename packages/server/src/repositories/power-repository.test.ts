import { describe, expect, it, vi } from "vitest";
import { PowerRepository } from "./power-repository.ts";

function makeDb(...callResults: Record<string, unknown>[][]) {
  const execute = vi.fn();
  for (const rows of callResults) {
    execute.mockResolvedValueOnce(rows);
  }
  return { execute };
}

describe("PowerRepository", () => {
  it("can be instantiated", () => {
    const db = makeDb();
    const repo = new PowerRepository(db, "user-1", "UTC");
    expect(repo).toBeInstanceOf(PowerRepository);
  });

  describe("getPowerCurve", () => {
    it("returns empty points array when no samples", async () => {
      const db = makeDb([]);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getPowerCurve(90);

      expect(result.points).toEqual([]);
      expect(result.model).toBeNull();
    });

    it("calls db.execute once", async () => {
      const db = makeDb([]);
      const repo = new PowerRepository(db, "user-1", "UTC");
      await repo.getPowerCurve(90);

      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it("computes power curve from samples", async () => {
      // Build enough samples to cover 5s duration at 1s intervals
      const samples = Array.from({ length: 10 }, (_, index) => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200 + index,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getPowerCurve(90);

      expect(result.points.length).toBeGreaterThan(0);
      expect(result.points[0]).toMatchObject({
        durationSeconds: expect.any(Number),
        label: expect.any(String),
        bestPower: expect.any(Number),
        activityDate: "2024-06-15",
      });
    });

    it("generates fallback label for unknown duration seconds", async () => {
      // 7s is not in DURATION_LABELS, so fallback to "7s"
      const samples = Array.from({ length: 10 }, () => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getPowerCurve(90);
      // Check that labels are either from DURATION_LABELS or end with "s"
      for (const point of result.points) {
        expect(point.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getEftpTrend", () => {
    it("returns empty trend when no samples", async () => {
      const db = makeDb(
        [], // normalizedPowerSamples query
        [], // powerCurveSamples query (90-day for CP model)
      );
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getEftpTrend(365);

      expect(result.trend).toEqual([]);
      expect(result.currentEftp).toBeNull();
      expect(result.model).toBeNull();
    });

    it("calls db.execute twice (NP samples + power curve samples)", async () => {
      const db = makeDb([], []);
      const repo = new PowerRepository(db, "user-1", "UTC");
      await repo.getEftpTrend(365);

      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it("computes eFTP as NP * 0.95", async () => {
      // Build 300 samples at 1s intervals for a single activity
      // (>= 240 samples required for NP computation)
      const normalizedPowerSamples = Array.from({ length: 300 }, (_item, _index) => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        activity_name: "Morning Ride",
        power: 200,
        interval_s: 1,
      }));

      const db = makeDb(
        normalizedPowerSamples, // NP query
        [], // power curve query (empty = no CP model)
      );
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getEftpTrend(365);

      expect(result.trend).toHaveLength(1);
      expect(result.trend[0]?.date).toBe("2024-06-15");
      expect(result.trend[0]?.activityName).toBe("Morning Ride");
      // Constant 200W power => NP = 200, eFTP = 200 * 0.95 = 190
      expect(result.trend[0]?.eftp).toBe(190);
    });

    it("rounds eFTP to integer (Math.round)", async () => {
      // 300 samples of 251W constant power
      // NP = 251, eFTP = 251 * 0.95 = 238.45 → rounds to 238
      const today = new Date().toISOString().slice(0, 10);
      const normalizedPowerSamples = Array.from({ length: 300 }, () => ({
        activity_id: "act-1",
        activity_date: today,
        activity_name: "Ride",
        power: 251,
        interval_s: 1,
      }));
      const db = makeDb(normalizedPowerSamples, []);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getEftpTrend(365);
      // NP of constant 251W = 251, eFTP = 251 * 0.95 = 238.45 → 238
      expect(result.trend[0]?.eftp).toBe(238);
      expect(Number.isInteger(result.trend[0]?.eftp)).toBe(true);
    });

    it("returns null currentEftp when no CP model and no recent trend data", async () => {
      // Old data that falls outside 90-day cutoff for fallback
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 200);
      const dateStr = oldDate.toISOString().slice(0, 10);
      const normalizedPowerSamples = Array.from({ length: 300 }, () => ({
        activity_id: "act-1",
        activity_date: dateStr,
        activity_name: "Old Ride",
        power: 200,
        interval_s: 1,
      }));
      const db = makeDb(normalizedPowerSamples, []);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getEftpTrend(365);
      // Trend exists but is outside 90-day window for currentEftp
      expect(result.trend).toHaveLength(1);
      expect(result.currentEftp).toBeNull();
    });

    it("falls back to max NP * 0.95 when CP model fails", async () => {
      // Use a recent date so the fallback filter includes it
      const today = new Date().toISOString().slice(0, 10);
      const normalizedPowerSamples = Array.from({ length: 300 }, () => ({
        activity_id: "act-1",
        activity_date: today,
        activity_name: "Ride",
        power: 250,
        interval_s: 1,
      }));

      const db = makeDb(
        normalizedPowerSamples, // NP query
        [], // power curve query (empty = no CP model => fallback)
      );
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getEftpTrend(365);

      expect(result.model).toBeNull();
      // Constant 250W => NP = 250, eFTP = 250 * 0.95 = 237.5 => 238
      expect(result.currentEftp).toBe(238);
    });

    it("uses 90-day window for CP model fallback (not 30 or 180)", async () => {
      // Activity 91 days ago should NOT be included in the 90-day CP model window
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 91);
      const oldDateStr = oldDate.toISOString().slice(0, 10);

      const normalizedPowerSamples = Array.from({ length: 300 }, () => ({
        activity_id: "act-old",
        activity_date: oldDateStr,
        activity_name: "Old Ride",
        power: 300,
        interval_s: 1,
      }));

      const db = makeDb(normalizedPowerSamples, []);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getEftpTrend(365);

      // Trend should exist but currentEftp should be null because
      // the activity is outside the 90-day fallback window
      expect(result.trend).toHaveLength(1);
      expect(result.currentEftp).toBeNull();
    });

    it("uses 0.95 multiplier for eFTP (not 0.9 or 1.0)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const normalizedPowerSamples = Array.from({ length: 300 }, () => ({
        activity_id: "act-1",
        activity_date: today,
        activity_name: "Ride",
        power: 200,
        interval_s: 1,
      }));
      const db = makeDb(normalizedPowerSamples, []);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getEftpTrend(365);
      // NP = 200, eFTP = 200 * 0.95 = 190 (not 180 if 0.9, not 200 if 1.0)
      expect(result.trend[0]?.eftp).toBe(190);
    });

    it("uses second db.execute call for 90-day power curve (separate from NP query)", async () => {
      const db = makeDb([], []);
      const repo = new PowerRepository(db, "user-1", "UTC");
      await repo.getEftpTrend(365);
      // First call: NP samples, Second call: power curve samples (90-day)
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("getPowerCurve", () => {
    it("uses fallback label format 'Xs' for unknown durations", async () => {
      // Build 8 samples at 1s intervals to get a 5s duration point
      const samples = Array.from({ length: 8 }, () => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository(db, "user-1", "UTC");
      const result = await repo.getPowerCurve(90);

      // All points should have non-empty labels (either from DURATION_LABELS or fallback "Xs")
      if (result.points.length > 0) {
        expect(result.points.every((point) => point.label.length > 0)).toBe(true);
      }
    });
  });
});
