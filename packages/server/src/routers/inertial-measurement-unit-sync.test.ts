import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn() },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

import { logger } from "../logger.ts";
import { inertialMeasurementUnitSyncRouter } from "./inertial-measurement-unit-sync.ts";

const createCaller = createTestCallerFactory(inertialMeasurementUnitSyncRouter);

function makeExecute() {
  return vi.fn().mockResolvedValue([]);
}

function flattenSqlChunk(chunk: unknown): Array<string | number> {
  if (typeof chunk === "string" || typeof chunk === "number") {
    return [chunk];
  }
  if (Array.isArray(chunk)) {
    return chunk.flatMap((item) => flattenSqlChunk(item));
  }
  if (typeof chunk !== "object" || chunk === null) {
    return [];
  }

  const queryChunks = Reflect.get(chunk, "queryChunks");
  if (Array.isArray(queryChunks)) {
    return queryChunks.flatMap((item) => flattenSqlChunk(item));
  }

  const value = Reflect.get(chunk, "value");
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenSqlChunk(item));
  }

  return [];
}

function getSqlParts(statement: unknown): Array<string | number> {
  return flattenSqlChunk(statement);
}

function makeSample(
  overrides: Partial<{
    timestamp: string;
    x: number;
    y: number;
    z: number;
    gyroscopeX: number;
    gyroscopeY: number;
    gyroscopeZ: number;
  }> = {},
) {
  return {
    timestamp: "2026-03-25T10:00:00.020Z",
    x: 0.012,
    y: -0.981,
    z: 0.043,
    ...overrides,
  };
}

describe("inertialMeasurementUnitSyncRouter", () => {
  describe("pushSamples", () => {
    it("inserts samples with correct SQL", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [makeSample(), makeSample({ timestamp: "2026-03-25T10:00:00.040Z", x: 0.015 })],
      });

      expect(result.inserted).toBe(2);
      // 1 ensureProvider + 1 metric_stream batch insert
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("handles empty samples array by returning zero inserted", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [],
      });

      expect(result.inserted).toBe(0);
      // Only ensureProvider, no insert
      expect(execute).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith("IMU push with 0 samples", {
        userId: "user-1",
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
      });
    });

    it("rejects samples with missing required fields", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const invalidSample = { timestamp: "2026-03-25T10:00:00Z", x: 0.1 };
      await expect(
        caller.pushSamples({
          deviceId: "iPhone 15 Pro",
          deviceType: "iphone",
          samples: [invalidSample],
        }),
      ).rejects.toThrow();
    });

    it("rejects when deviceId is empty", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(
        caller.pushSamples({
          deviceId: "",
          deviceType: "iphone",
          samples: [makeSample()],
        }),
      ).rejects.toThrow();
    });

    it("batches large sample arrays into multiple INSERT statements", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const samples = Array.from({ length: 7500 }, (_, index) =>
        makeSample({
          timestamp: `2026-03-25T10:00:${String(Math.floor(index / 50)).padStart(2, "0")}.${String((index % 50) * 20).padStart(3, "0")}Z`,
        }),
      );

      const result = await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples,
      });

      expect(result.inserted).toBe(7500);
      // 1 ensureProvider + 2 metric_stream batch inserts = 3
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it("accepts samples with optional gyroscope fields", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.pushSamples({
        deviceId: "WHOOP Strap",
        deviceType: "whoop",
        samples: [
          makeSample({
            gyroscopeX: 0.15,
            gyroscopeY: -0.22,
            gyroscopeZ: 0.08,
          }),
        ],
      });

      expect(result.inserted).toBe(1);
      expect(execute).toHaveBeenCalledTimes(2);

      const insertStatement = execute.mock.calls[1]?.[0];
      const sqlParts = getSqlParts(insertStatement);

      expect(sqlParts).toContain("imu");
      expect(sqlParts).toContain("2026-03-25T10:00:00.020Z");
      expect(sqlParts).toEqual(expect.arrayContaining([0.012, -0.981, 0.043, 0.15, -0.22, 0.08]));
    });

    it("accepts a mix of samples with and without gyroscope", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.pushSamples({
        deviceId: "Apple Watch",
        deviceType: "apple_watch",
        samples: [
          makeSample(), // accel only
          makeSample({
            timestamp: "2026-03-25T10:00:00.040Z",
            gyroscopeX: 0.1,
            gyroscopeY: 0.2,
            gyroscopeZ: 0.3,
          }), // accel + gyro
        ],
      });

      expect(result.inserted).toBe(2);
      expect(execute).toHaveBeenCalledTimes(2);

      const insertStatement = execute.mock.calls[1]?.[0];
      const sqlParts = getSqlParts(insertStatement);

      expect(sqlParts.filter((part) => part === "accel")).toHaveLength(1);
      expect(sqlParts.filter((part) => part === "imu")).toHaveLength(1);
      expect(sqlParts).toEqual(expect.arrayContaining([0.1, 0.2, 0.3]));
      expect(logger.info).toHaveBeenCalledWith(
        "IMU samples pushed",
        expect.objectContaining({
          userId: "user-1",
          deviceId: "Apple Watch",
          deviceType: "apple_watch",
          sampleCount: 2,
          firstTimestamp: "2026-03-25T10:00:00.020Z",
          lastTimestamp: "2026-03-25T10:00:00.040Z",
        }),
      );
    });

    it.each([
      [{ gyroscopeX: 0.4 }, [0.4, 0, 0]],
      [{ gyroscopeY: 0.5 }, [0, 0.5, 0]],
      [{ gyroscopeZ: 0.6 }, [0, 0, 0.6]],
    ] as const)("treats a partial gyroscope sample as a 6-axis imu vector", async (overrides, expectedGyroValues) => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await caller.pushSamples({
        deviceId: "Apple Watch",
        deviceType: "apple_watch",
        samples: [makeSample(overrides)],
      });

      const insertStatement = execute.mock.calls[1]?.[0];
      const sqlParts = getSqlParts(insertStatement);

      expect(sqlParts).toContain("imu");
      expect(sqlParts).toEqual(expect.arrayContaining(expectedGyroValues));
    });

    it("logs the full timestamp range for successful pushes", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await caller.pushSamples({
        deviceId: "Apple Watch",
        deviceType: "apple_watch",
        samples: [
          makeSample({ timestamp: "2026-03-25T10:00:00.020Z" }),
          makeSample({ timestamp: "2026-03-25T10:00:00.080Z" }),
          makeSample({ timestamp: "2026-03-25T10:00:00.140Z" }),
        ],
      });

      expect(logger.info).toHaveBeenCalledWith(
        "IMU samples pushed",
        expect.objectContaining({
          firstTimestamp: "2026-03-25T10:00:00.020Z",
          lastTimestamp: "2026-03-25T10:00:00.140Z",
          serverTime: expect.any(String),
        }),
      );
    });
  });
});
