import { describe, expect, it, vi } from "vitest";
import { InertialMeasurementUnitRepository } from "./inertial-measurement-unit-repository.ts";

describe("InertialMeasurementUnitRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new InertialMeasurementUnitRepository({ execute }, "user-1");
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
          sample_count: "500000",
          latest_sample: "2025-01-15T12:00:00Z",
          earliest_sample: "2025-01-01T08:00:00Z",
        },
      ]);
      const result = await repo.getSyncStatus();
      expect(result).toEqual([
        {
          deviceId: "iphone-14",
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

  describe("getCoverageTimeline", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getCoverageTimeline("2025-01-15")).toEqual([]);
    });

    it("maps DB rows to CoverageBucket objects", async () => {
      const { repo } = makeRepository([
        { bucket: "2025-01-15 10:00:00+00", sample_count: "15000" },
        { bucket: "2025-01-15 10:05:00+00", sample_count: "14800" },
      ]);
      const result = await repo.getCoverageTimeline("2025-01-15");
      expect(result).toEqual([
        { bucket: "2025-01-15 10:00:00+00", sampleCount: 15000 },
        { bucket: "2025-01-15 10:05:00+00", sampleCount: 14800 },
      ]);
    });

    it("coerces string numbers from postgres", async () => {
      const { repo } = makeRepository([
        { bucket: "2025-01-15 10:00:00+00", sample_count: "12345" },
      ]);
      const result = await repo.getCoverageTimeline("2025-01-15");
      expect(result[0]?.sampleCount).toBe(12345);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getCoverageTimeline("2025-01-15");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getDailyHeatmap", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getDailyHeatmap(30)).toEqual([]);
    });

    it("maps snake_case DB rows to camelCase domain objects", async () => {
      const { repo } = makeRepository([
        { date: "2025-01-15", hour: "10", sample_count: "180000", coverage_percent: "100.0" },
        { date: "2025-01-15", hour: "11", sample_count: "90000", coverage_percent: "50.0" },
        { date: "2025-01-14", hour: "8", sample_count: "180000", coverage_percent: "100.0" },
      ]);
      const result = await repo.getDailyHeatmap(30);
      expect(result).toEqual([
        { date: "2025-01-15", hour: 10, sampleCount: 180000, coveragePercent: 100 },
        { date: "2025-01-15", hour: 11, sampleCount: 90000, coveragePercent: 50 },
        { date: "2025-01-14", hour: 8, sampleCount: 180000, coveragePercent: 100 },
      ]);
    });

    it("coerces string numbers from postgres", async () => {
      const { repo } = makeRepository([
        { date: "2025-01-15", hour: "14", sample_count: "42", coverage_percent: "0.0" },
      ]);
      const result = await repo.getDailyHeatmap(30);
      expect(result[0]?.hour).toBe(14);
      expect(result[0]?.sampleCount).toBe(42);
      expect(result[0]?.coveragePercent).toBe(0);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getDailyHeatmap(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getTimeSeries", () => {
    it("returns empty array when no samples in range", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getTimeSeries("2025-01-15T10:00:00Z", "2025-01-15T10:05:00Z")).toEqual([]);
    });

    it("maps DB rows to InertialMeasurementUnitSample objects", async () => {
      const { repo } = makeRepository([
        {
          recorded_at: "2025-01-15T10:00:00Z",
          x: "0.01",
          y: "-9.81",
          z: "0.02",
          gyroscope_x: "0.1",
          gyroscope_y: "-0.2",
          gyroscope_z: null,
        },
      ]);
      const result = await repo.getTimeSeries("2025-01-15T10:00:00Z", "2025-01-15T10:01:00Z");
      expect(result).toEqual([
        {
          recordedAt: "2025-01-15T10:00:00Z",
          x: 0.01,
          y: -9.81,
          z: 0.02,
          gyroscopeX: 0.1,
          gyroscopeY: -0.2,
          gyroscopeZ: null,
        },
      ]);
    });

    it("clamps end date to 10 minutes after start", async () => {
      const { repo, execute } = makeRepository([]);
      const start = "2025-01-15T10:00:00Z";
      const end = "2025-01-15T11:00:00Z"; // 1 hour later

      await repo.getTimeSeries(start, end);

      expect(execute).toHaveBeenCalledTimes(1);
      // Verify the SQL contains the clamped end (10 min after start), not the original end
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("2025-01-15T10:10:00.000Z");
      expect(queryJson).not.toContain("2025-01-15T11:00:00.000Z");
    });

    it("does not clamp when end is within 10 minutes", async () => {
      const { repo, execute } = makeRepository([]);
      const start = "2025-01-15T10:00:00Z";
      const end = "2025-01-15T10:05:00Z"; // 5 minutes later, within limit

      await repo.getTimeSeries(start, end);
      expect(execute).toHaveBeenCalledTimes(1);
      // Verify the original end is used, not the maxEnd
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("2025-01-15T10:05:00.000Z");
    });

    it("uses the original end when it equals the max window boundary", async () => {
      const { repo, execute } = makeRepository([]);
      const start = "2025-01-15T10:00:00Z";
      const end = "2025-01-15T10:10:00.000Z"; // exactly 10 minutes

      await repo.getTimeSeries(start, end);
      expect(execute).toHaveBeenCalledTimes(1);
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("2025-01-15T10:10:00.000Z");
    });

    it("uses start date in the SQL query", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getTimeSeries("2025-01-15T10:00:00Z", "2025-01-15T10:05:00Z");
      const queryJson = JSON.stringify(execute.mock.calls[0]?.[0]);
      expect(queryJson).toContain("2025-01-15T10:00:00.000Z");
    });
  });
});
