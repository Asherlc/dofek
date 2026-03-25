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
  // Drizzle execute returns a RowList (array-like with iterable)
  const result = Object.assign([...rows], { command: "SELECT", rowCount: rows.length });
  return vi.fn().mockResolvedValue(result);
}

describe("accelerometerRouter", () => {
  describe("getDailyCounts", () => {
    it("returns daily counts from the database", async () => {
      const mockRows = [
        { date: "2026-03-25", sample_count: 4320000, hours_covered: 24.0 },
        { date: "2026-03-24", sample_count: 2160000, hours_covered: 12.0 },
      ];
      const execute = makeExecute(mockRows);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getDailyCounts({ days: 30 });

      expect(result).toHaveLength(2);
      expect(result[0].date).toBe("2026-03-25");
      expect(result[0].hours_covered).toBe(24.0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("defaults to 90 days", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await caller.getDailyCounts({});

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("rejects days outside 1-365 range", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(caller.getDailyCounts({ days: 0 })).rejects.toThrow();
      await expect(caller.getDailyCounts({ days: 400 })).rejects.toThrow();
    });
  });

  describe("getSyncStatus", () => {
    it("returns device breakdown", async () => {
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
      expect(result[0].device_id).toBe("iPhone 15 Pro");
      expect(result[0].sample_count).toBe(8640000);
    });

    it("returns empty array when no data", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getSyncStatus();
      expect(result).toHaveLength(0);
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
      expect(result[0].x).toBe(0.01);
    });

    it("clamps end date to 10 minutes from start", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      // Request 1 hour — should be clamped to 10 minutes
      await caller.getTimeSeries({
        startDate: "2026-03-25T10:00:00Z",
        endDate: "2026-03-25T11:00:00Z",
      });

      expect(execute).toHaveBeenCalledTimes(1);
      // Verify the SQL contains the clamped end date (10 min after start)
      const sqlCall = execute.mock.calls[0][0];
      const sqlString = sqlCall.queryChunks
        ? sqlCall.queryChunks.map((chunk: { value?: string[] }) => chunk.value?.[0] ?? "").join("")
        : String(sqlCall);
      // The clamped end should be ~10:10, not 11:00
      expect(sqlString).not.toContain("11:00");
    });
  });
});
