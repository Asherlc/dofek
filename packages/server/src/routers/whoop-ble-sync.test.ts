import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock trpc with a real tRPC setup
vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string; timezone: string }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    adminProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { whoopBleSyncRouter } from "./whoop-ble-sync.ts";

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

function makeMockDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

function makeCtx(database = makeMockDb()) {
  return {
    db: database,
    userId: "test-user-id",
    timezone: "America/New_York",
  };
}

describe("whoopBleSyncRouter", () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    mockDb = makeMockDb();
    ctx = makeCtx(mockDb);
  });

  describe("pushRealtimeData", () => {
    const caller = whoopBleSyncRouter.createCaller;

    it("returns zero inserted for empty samples array", async () => {
      const trpcCaller = caller(ctx);
      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [],
      });

      expect(result).toEqual({ inserted: 0 });
    });

    it("ensures the whoop_ble provider exists before inserting", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            quaternionW: 0.02,
            quaternionX: 0.68,
            quaternionY: -0.71,
            quaternionZ: 0.2,
          },
        ],
      });

      // First db.execute call is the provider upsert (before any data inserts)
      expect(mockDb.execute).toHaveBeenCalled();
      // 3 calls: provider upsert + HR sensor_sample + orientation sensor_sample
      expect(mockDb.execute.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("inserts HR into sensor_sample for samples with heartRate > 0", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            quaternionW: 1.0,
            quaternionX: 0.0,
            quaternionY: 0.0,
            quaternionZ: 0.0,
          },
        ],
      });

      // 3 calls: ensure provider + HR sensor_sample + orientation sensor_sample
      expect(mockDb.execute).toHaveBeenCalledTimes(3);

      const heartRateInsert = mockDb.execute.mock.calls[1]?.[0];
      const sqlParts = getSqlParts(heartRateInsert);

      expect(sqlParts).toEqual(
        expect.arrayContaining(["heart_rate", "2026-03-30T12:00:00.000Z", "WHOOP Strap", 72]),
      );
    });

    it("skips heart-rate insert when all heartRate values are 0", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 0,
            quaternionW: 1.0,
            quaternionX: 0.0,
            quaternionY: 0.0,
            quaternionZ: 0.0,
          },
        ],
      });

      // 2 calls: ensure provider + orientation sensor_sample
      expect(mockDb.execute).toHaveBeenCalledTimes(2);
    });

    it("inserts orientation data into sensor_sample", async () => {
      const trpcCaller = caller(ctx);
      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 80,
            quaternionW: 0.5,
            quaternionX: 0.5,
            quaternionY: 0.5,
            quaternionZ: 0.5,
          },
          {
            timestamp: "2026-03-30T12:00:01.000Z",
            heartRate: 82,
            quaternionW: 0.5,
            quaternionX: 0.5,
            quaternionY: -0.5,
            quaternionZ: 0.5,
          },
        ],
      });

      expect(result).toEqual({ inserted: 2 });

      const orientationInsert = mockDb.execute.mock.calls[2]?.[0];
      const sqlParts = getSqlParts(orientationInsert);

      expect(sqlParts).toEqual(
        expect.arrayContaining([
          "orientation",
          "2026-03-30T12:00:00.000Z",
          "2026-03-30T12:00:01.000Z",
          0.5,
          -0.5,
        ]),
      );
    });

    it("skips orientation insert when quaternion is all zeros (compact 0x28)", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 62,
            quaternionW: 0.0,
            quaternionX: 0.0,
            quaternionY: 0.0,
            quaternionZ: 0.0,
          },
        ],
      });

      // 2 calls: ensure provider + HR sensor_sample
      expect(mockDb.execute).toHaveBeenCalledTimes(2);
    });

    it("inserts rr interval samples when heart-rate samples include rrIntervalMs", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            rrIntervalMs: 812,
            quaternionW: 0.2,
            quaternionX: 0.3,
            quaternionY: 0.4,
            quaternionZ: 0.5,
          },
        ],
      });

      // ensure provider + heart_rate + rr_interval_ms + orientation
      expect(mockDb.execute).toHaveBeenCalledTimes(4);

      const rrInsert = mockDb.execute.mock.calls[2]?.[0];
      const sqlParts = getSqlParts(rrInsert);

      expect(sqlParts).toEqual(
        expect.arrayContaining(["rr_interval_ms", "2026-03-30T12:00:00.000Z", "WHOOP Strap", 812]),
      );
    });

    it("inserts orientation when only quaternionX is non-zero", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            quaternionW: 0,
            quaternionX: 0.5,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      // 3 calls: ensure provider + HR sensor_sample + orientation sensor_sample
      expect(mockDb.execute).toHaveBeenCalledTimes(3);
    });

    it("inserts orientation when only quaternionY is non-zero", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0.5,
            quaternionZ: 0,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
    });

    it("inserts orientation when only quaternionZ is non-zero", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0.5,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
    });

    it("logs timestamps and sample count on successful push", async () => {
      const { logger } = await import("../logger.ts");
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
          {
            timestamp: "2026-03-30T12:00:01.000Z",
            heartRate: 74,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      expect(logger.info).toHaveBeenCalledWith(
        "WHOOP BLE realtime data pushed",
        expect.objectContaining({
          userId: "test-user-id",
          deviceId: "WHOOP Strap",
          sampleCount: 2,
          firstTimestamp: "2026-03-30T12:00:00.000Z",
          lastTimestamp: "2026-03-30T12:00:01.000Z",
        }),
      );
    });

    it("logs with correct message for empty samples", async () => {
      const { logger } = await import("../logger.ts");
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [],
      });

      expect(logger.info).toHaveBeenCalledWith(
        "WHOOP BLE realtime push with 0 samples",
        expect.objectContaining({ userId: "test-user-id" }),
      );
    });

    it("includes correct inserted count in return value", async () => {
      const trpcCaller = caller(ctx);
      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRate: 72,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      expect(result).toEqual({ inserted: 1 });
    });

    it("rejects invalid heartRate values", async () => {
      const trpcCaller = caller(ctx);

      await expect(
        trpcCaller.pushRealtimeData({
          deviceId: "WHOOP Strap",
          samples: [
            {
              timestamp: "2026-03-30T12:00:00.000Z",
              heartRate: 300, // exceeds max 255
              quaternionW: 1.0,
              quaternionX: 0.0,
              quaternionY: 0.0,
              quaternionZ: 0.0,
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it("rejects missing deviceId", async () => {
      const trpcCaller = caller(ctx);

      await expect(
        trpcCaller.pushRealtimeData({
          deviceId: "",
          samples: [],
        }),
      ).rejects.toThrow();
    });

    it("handles batch splitting for large sample arrays", async () => {
      const trpcCaller = caller(ctx);
      // Create 2500 samples (exceeds INSERT_BATCH_SIZE of 2000)
      const samples = Array.from({ length: 2500 }, (_, index) => ({
        timestamp: new Date(1711800000000 + index * 1000).toISOString(),
        heartRate: 72,
        quaternionW: 1.0,
        quaternionX: 0.0,
        quaternionY: 0.0,
        quaternionZ: 0.0,
      }));

      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples,
      });

      expect(result).toEqual({ inserted: 2500 });
      // 1 ensure provider + 2 batches × (HR sensor_sample + orientation sensor_sample) = 5 calls
      expect(mockDb.execute).toHaveBeenCalledTimes(5);
    });
  });
});
