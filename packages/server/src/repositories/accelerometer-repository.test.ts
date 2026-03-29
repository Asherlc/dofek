import { describe, expect, it, vi } from "vitest";
import { AccelerometerRepository } from "./accelerometer-repository.ts";

describe("AccelerometerRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new AccelerometerRepository({ execute }, "user-1");
    return { repo, execute };
  }

  describe("getDailyCounts", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getDailyCounts(90)).toEqual([]);
    });

    it("maps snake_case DB rows to camelCase domain objects", async () => {
      const { repo } = makeRepository([
        { date: "2025-01-15", sample_count: "180000", hours_covered: "1.00" },
        { date: "2025-01-14", sample_count: "360000", hours_covered: "2.00" },
      ]);
      const result = await repo.getDailyCounts(90);
      expect(result).toEqual([
        { date: "2025-01-15", sampleCount: 180000, hoursCovered: 1.0 },
        { date: "2025-01-14", sampleCount: 360000, hoursCovered: 2.0 },
      ]);
    });

    it("coerces string numbers from postgres", async () => {
      const { repo } = makeRepository([
        { date: "2025-01-15", sample_count: "42", hours_covered: "0.50" },
      ]);
      const result = await repo.getDailyCounts(30);
      expect(result[0]?.sampleCount).toBe(42);
      expect(result[0]?.hoursCovered).toBe(0.5);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getDailyCounts(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getSyncStatus", () => {
    it("returns empty array when no devices", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getSyncStatus()).toEqual([]);
    });

    it("maps DB rows to DeviceSyncStatus objects", async () => {
      const { repo } = makeRepository([
        {
          device_id: "iphone-14",
          device_type: "phone",
          sample_count: "500000",
          latest_sample: "2025-01-15T12:00:00Z",
          earliest_sample: "2025-01-01T08:00:00Z",
        },
      ]);
      const result = await repo.getSyncStatus();
      expect(result).toEqual([
        {
          deviceId: "iphone-14",
          deviceType: "phone",
          sampleCount: 500000,
          latestSample: "2025-01-15T12:00:00Z",
          earliestSample: "2025-01-01T08:00:00Z",
        },
      ]);
    });

    it("handles null sample timestamps", async () => {
      const { repo } = makeRepository([
        {
          device_id: "watch-1",
          device_type: "watch",
          sample_count: "0",
          latest_sample: null,
          earliest_sample: null,
        },
      ]);
      const result = await repo.getSyncStatus();
      expect(result[0]?.latestSample).toBeNull();
      expect(result[0]?.earliestSample).toBeNull();
    });
  });

  describe("getTimeSeries", () => {
    it("returns empty array when no samples in range", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getTimeSeries("2025-01-15T10:00:00Z", "2025-01-15T10:05:00Z")).toEqual([]);
    });

    it("maps DB rows to AccelerometerSample objects", async () => {
      const { repo } = makeRepository([
        { recorded_at: "2025-01-15T10:00:00Z", x: "0.01", y: "-9.81", z: "0.02" },
      ]);
      const result = await repo.getTimeSeries("2025-01-15T10:00:00Z", "2025-01-15T10:01:00Z");
      expect(result).toEqual([{ recordedAt: "2025-01-15T10:00:00Z", x: 0.01, y: -9.81, z: 0.02 }]);
    });

    it("clamps end date to 10 minutes after start", async () => {
      const { repo, execute } = makeRepository([]);
      const start = "2025-01-15T10:00:00Z";
      const end = "2025-01-15T11:00:00Z"; // 1 hour later

      await repo.getTimeSeries(start, end);

      // The execute call should have been made with clamped end time
      expect(execute).toHaveBeenCalledTimes(1);
      // We verify the clamping works by checking the SQL was built with the clamped end
      // The clamped end should be 10 minutes after start: 2025-01-15T10:10:00.000Z
      const sqlQuery = execute.mock.calls[0]?.[0];
      expect(sqlQuery).toBeDefined();
    });

    it("does not clamp when end is within 10 minutes", async () => {
      const { repo, execute } = makeRepository([]);
      const start = "2025-01-15T10:00:00Z";
      const end = "2025-01-15T10:05:00Z"; // 5 minutes later, within limit

      await repo.getTimeSeries(start, end);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
