import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

import { accelerometerRouter } from "./accelerometer.ts";

const createCaller = createTestCallerFactory(accelerometerRouter);

function makeExecute(rows: unknown[] = []) {
  const result = Object.assign([...rows], { command: "SELECT", rowCount: rows.length });
  return vi.fn().mockResolvedValue(result);
}

/** Extract parameter values from a Drizzle sql tagged template query.
 * queryChunks alternates: [{value: ["sql"]}, paramValue, {value: ["sql"]}, paramValue, ...] */
function extractSqlParams(execute: ReturnType<typeof vi.fn>): unknown[] {
  const query = execute.mock.calls[0]?.[0];
  if (!query || !query.queryChunks) return [];
  return query.queryChunks.filter((_: unknown, index: number) => index % 2 === 1);
}

describe("accelerometerRouter", () => {
  describe("getDailyCounts", () => {
    it("returns all rows from the database", async () => {
      const mockRows = [
        { date: "2026-03-25", sample_count: 4320000, hours_covered: 24.0 },
        { date: "2026-03-24", sample_count: 2160000, hours_covered: 12.0 },
      ];
      const execute = makeExecute(mockRows);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getDailyCounts({ days: 30 });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        date: "2026-03-25",
        sampleCount: 4320000,
        hoursCovered: 24.0,
      });
      expect(result[1]).toEqual({
        date: "2026-03-24",
        sampleCount: 2160000,
        hoursCovered: 12.0,
      });
    });

    it("passes userId and days to the SQL query", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-42" });

      await caller.getDailyCounts({ days: 7 });

      expect(execute).toHaveBeenCalledTimes(1);
      const params = extractSqlParams(execute);
      expect(params).toContain("user-42");
      expect(params).toContain(7);
    });

    it("defaults to 90 days when not specified", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await caller.getDailyCounts({});

      const params = extractSqlParams(execute);
      expect(params).toContain(90);
    });

    it("rejects days below minimum (0)", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(caller.getDailyCounts({ days: 0 })).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    });

    it("rejects days above maximum (366+)", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(caller.getDailyCounts({ days: 400 })).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    });

    it("returns empty array when no data", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getDailyCounts({ days: 30 });
      expect(result).toEqual([]);
    });
  });

  describe("getSyncStatus", () => {
    it("returns device breakdown with all fields", async () => {
      const mockRows = [
        {
          device_id: "iPhone 15 Pro",
          device_type: "iphone",
          sample_count: 8640000,
          latest_sample: "2026-03-25T12:00:00Z",
          earliest_sample: "2026-03-23T00:00:00Z",
        },
      ];
      const execute = makeExecute(mockRows);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getSyncStatus();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        sampleCount: 8640000,
        latestSample: "2026-03-25T12:00:00Z",
        earliestSample: "2026-03-23T00:00:00Z",
      });
    });

    it("passes userId to the SQL query", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-99" });

      await caller.getSyncStatus();

      expect(execute).toHaveBeenCalledTimes(1);
      const params = extractSqlParams(execute);
      expect(params).toContain("user-99");
    });

    it("returns empty array when no data", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getSyncStatus();
      expect(result).toEqual([]);
    });
  });

  describe("getTimeSeries", () => {
    it("returns raw samples for a time window", async () => {
      const mockRows = [
        { recorded_at: "2026-03-25T10:00:00.000Z", x: 0.01, y: -0.98, z: 0.04 },
        { recorded_at: "2026-03-25T10:00:00.020Z", x: 0.02, y: -0.97, z: 0.05 },
      ];
      const execute = makeExecute(mockRows);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getTimeSeries({
        startDate: "2026-03-25T10:00:00Z",
        endDate: "2026-03-25T10:01:00Z",
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        recordedAt: "2026-03-25T10:00:00.000Z",
        x: 0.01,
        y: -0.98,
        z: 0.04,
      });
      expect(result[1]).toEqual({
        recordedAt: "2026-03-25T10:00:00.020Z",
        x: 0.02,
        y: -0.97,
        z: 0.05,
      });
    });

    it("does not clamp when end is within 10 minutes of start", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await caller.getTimeSeries({
        startDate: "2026-03-25T10:00:00Z",
        endDate: "2026-03-25T10:05:00Z",
      });

      const params = extractSqlParams(execute);
      // End date should be the original (10:05), not clamped
      const endParam = params.find(
        (parameter) => typeof parameter === "string" && parameter.includes("10:05"),
      );
      expect(endParam).toBeDefined();
    });

    it("clamps end date to 10 minutes from start", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await caller.getTimeSeries({
        startDate: "2026-03-25T10:00:00Z",
        endDate: "2026-03-25T11:00:00Z",
      });

      expect(execute).toHaveBeenCalledTimes(1);
      const params = extractSqlParams(execute);
      // Should clamp to 10:10, NOT use 11:00
      const endParam = params.find(
        (parameter) => typeof parameter === "string" && parameter.includes("10:10"),
      );
      expect(endParam).toBeDefined();
      const hasOriginalEnd = params.some(
        (parameter) => typeof parameter === "string" && parameter.includes("11:00"),
      );
      expect(hasOriginalEnd).toBe(false);
    });

    it("passes userId and start date to the SQL query", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-abc" });

      await caller.getTimeSeries({
        startDate: "2026-03-25T10:00:00Z",
        endDate: "2026-03-25T10:01:00Z",
      });

      const params = extractSqlParams(execute);
      expect(params).toContain("user-abc");
      const hasStart = params.some(
        (parameter) => typeof parameter === "string" && parameter.includes("2026-03-25T10:00:00"),
      );
      expect(hasStart).toBe(true);
    });
  });
});
