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
      // At least 3 calls: provider upsert + metric_stream + orientation_sample
      expect(mockDb.execute.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("inserts HR into metric_stream for samples with heartRate > 0", async () => {
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

      // Should have 3 execute calls: ensure provider, metric_stream insert, orientation insert
      expect(mockDb.execute).toHaveBeenCalledTimes(3);
    });

    it("skips metric_stream insert when all heartRate values are 0", async () => {
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

      // Should have 2 execute calls: ensure provider + orientation insert (no metric_stream)
      expect(mockDb.execute).toHaveBeenCalledTimes(2);
    });

    it("inserts orientation data into orientation_sample", async () => {
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
      // 1 ensure provider + 2 batches × (metric_stream + orientation) = 5 calls
      expect(mockDb.execute).toHaveBeenCalledTimes(5);
    });
  });
});
