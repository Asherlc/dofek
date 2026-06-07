import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock trpc with a real tRPC setup
vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; metricStreamPublisher?: unknown; userId: string; timezone: string }>()
    .create();
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
    execute: vi.fn(async () => []),
  };
}

function makeMetricStreamPublisher() {
  return {
    publishRows: vi.fn(async (rows: readonly unknown[]) =>
      rows.map((_, index) => ({ id: `event-${index}` })),
    ),
  };
}

function getPublishedRows(publisher: ReturnType<typeof makeMetricStreamPublisher>): unknown[] {
  return publisher.publishRows.mock.calls.flatMap((call) => [...call[0]]);
}

function makeCtx(
  database = makeMockDb(),
  metricStreamPublisher: ReturnType<typeof makeMetricStreamPublisher> = makeMetricStreamPublisher(),
) {
  return {
    db: database,
    metricStreamPublisher,
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
            rrIntervalMs: 812,
            quaternionW: 0.02,
            quaternionX: 0.68,
            quaternionY: -0.71,
            quaternionZ: 0.2,
          },
        ],
      });

      // First db.execute call is the provider upsert (before any data inserts)
      expect(mockDb.execute).toHaveBeenCalled();
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("publishes realtime data through Redpanda without inserting metric stream rows into Postgres", async () => {
      const metricStreamPublisher = {
        publishRows: vi.fn(async (rows: readonly unknown[]) =>
          rows.map((_, index) => ({ id: `event-${index}` })),
        ),
      };
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);

      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            rrIntervalMs: 812,
            quaternionW: 0.02,
            quaternionX: 0.68,
            quaternionY: -0.71,
            quaternionZ: 0.2,
          },
        ],
      });

      expect(result).toEqual({ inserted: 2 });
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledWith([
        expect.objectContaining({
          providerId: "whoop_ble",
          channel: "rr_interval_ms",
          scalar: 812,
        }),
        expect.objectContaining({
          providerId: "whoop_ble",
          channel: "orientation",
          vector: [0.02, 0.68, -0.71, 0.2],
        }),
      ]);
    });

    it("stores R-R intervals without requiring or inserting device heart rate", async () => {
      const metricStreamPublisher = makeMetricStreamPublisher();
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00Z",
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "rr_interval_ms", scalar: 812 }),
      ]);
    });

    it("writes deterministic external IDs and treats duplicate realtime samples as no-ops", async () => {
      const metricStreamPublisher = makeMetricStreamPublisher();
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0.5,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      expect(getPublishedRows(metricStreamPublisher)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalId: "whoop_ble:WHOOP Strap:rr_interval_ms:2026-03-30T12:00:00.000Z",
          }),
          expect.objectContaining({
            externalId: "whoop_ble:WHOOP Strap:orientation:2026-03-30T12:00:00.000Z",
          }),
        ]),
      );
    });

    it("ignores legacy heartRate fields instead of storing device-derived HR", async () => {
      const metricStreamPublisher = makeMetricStreamPublisher();
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);
      const legacySample = {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRate: 72,
        rrIntervalMs: 812,
        quaternionW: 0,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
      };

      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [legacySample],
      });

      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "rr_interval_ms", scalar: 812 }),
      ]);
    });

    it("publishes orientation data", async () => {
      const metricStreamPublisher = makeMetricStreamPublisher();
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);
      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            quaternionW: 0.5,
            quaternionX: 0.5,
            quaternionY: 0.5,
            quaternionZ: 0.5,
          },
          {
            timestamp: "2026-03-30T12:00:01.000Z",
            quaternionW: 0.5,
            quaternionX: 0.5,
            quaternionY: -0.5,
            quaternionZ: 0.5,
          },
        ],
      });

      expect(result).toEqual({ inserted: 2 });
      expect(getPublishedRows(metricStreamPublisher)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: "orientation",
            recordedAt: "2026-03-30T12:00:00.000Z",
            vector: [0.5, 0.5, 0.5, 0.5],
          }),
          expect.objectContaining({
            channel: "orientation",
            recordedAt: "2026-03-30T12:00:01.000Z",
            vector: [0.5, 0.5, -0.5, 0.5],
          }),
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
            rrIntervalMs: 812,
            quaternionW: 0.0,
            quaternionX: 0.0,
            quaternionY: 0.0,
            quaternionZ: 0.0,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("inserts R-R interval samples when samples include rrIntervalMs", async () => {
      const metricStreamPublisher = makeMetricStreamPublisher();
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            rrIntervalMs: 812,
            quaternionW: 0.2,
            quaternionX: 0.3,
            quaternionY: 0.4,
            quaternionZ: 0.5,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(getPublishedRows(metricStreamPublisher)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: "rr_interval_ms",
            recordedAt: "2026-03-30T12:00:00.000Z",
            deviceId: "WHOOP Strap",
            scalar: 812,
          }),
        ]),
      );
    });

    it("inserts orientation when only quaternionX is non-zero", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            quaternionW: 0,
            quaternionX: 0.5,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("inserts orientation when only quaternionY is non-zero", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0.5,
            quaternionZ: 0,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("inserts orientation when only quaternionZ is non-zero", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0.5,
          },
        ],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("logs timestamps and sample count on successful push", async () => {
      const { logger } = await import("../logger.ts");
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
          {
            timestamp: "2026-03-30T12:00:01.000Z",
            rrIntervalMs: 810,
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
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      expect(result).toEqual({ inserted: 1 });
    });

    it("returns zero inserted when duplicate realtime rows no-op", async () => {
      mockDb.execute.mockResolvedValue([]);
      const metricStreamPublisher = makeMetricStreamPublisher();
      metricStreamPublisher.publishRows.mockResolvedValue([]);
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);

      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      expect(result).toEqual({ inserted: 0 });
    });

    it("rejects invalid R-R interval values", async () => {
      const trpcCaller = caller(ctx);

      await expect(
        trpcCaller.pushRealtimeData({
          deviceId: "WHOOP Strap",
          samples: [
            {
              timestamp: "2026-03-30T12:00:00.000Z",
              rrIntervalMs: 32768,
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

    it("rejects samples more than five minutes in the future", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

      const trpcCaller = caller(ctx);

      try {
        await expect(
          trpcCaller.pushRealtimeData({
            deviceId: "WHOOP Strap",
            samples: [
              {
                timestamp: "2026-03-30T12:06:00.001Z",
                rrIntervalMs: 812,
                quaternionW: 1.0,
                quaternionX: 0.0,
                quaternionY: 0.0,
                quaternionZ: 0.0,
              },
            ],
          }),
        ).rejects.toThrow("WHOOP BLE sample timestamp is too far in the future");

        expect(mockDb.execute).toHaveBeenCalledTimes(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects malformed sample timestamps", async () => {
      const trpcCaller = caller(ctx);

      await expect(
        trpcCaller.pushRealtimeData({
          deviceId: "WHOOP Strap",
          samples: [
            {
              timestamp: "not-a-timestamp",
              rrIntervalMs: 812,
              quaternionW: 1.0,
              quaternionX: 0.0,
              quaternionY: 0.0,
              quaternionZ: 0.0,
            },
          ],
        }),
      ).rejects.toThrow("WHOOP BLE sample timestamp is invalid");

      expect(mockDb.execute).toHaveBeenCalledTimes(0);
    });

    it("handles batch splitting for large sample arrays", async () => {
      const metricStreamPublisher = makeMetricStreamPublisher();
      ctx = makeCtx(mockDb, metricStreamPublisher);
      const trpcCaller = caller(ctx);
      // Create 2500 samples (exceeds INSERT_BATCH_SIZE of 2000)
      const samples = Array.from({ length: 2500 }, (_, index) => ({
        timestamp: new Date(1711800000000 + index * 1000).toISOString(),
        rrIntervalMs: 812,
        quaternionW: 1.0,
        quaternionX: 0.0,
        quaternionY: 0.0,
        quaternionZ: 0.0,
      }));

      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples,
      });

      expect(result).toEqual({ inserted: 5000 });
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(2);
      expect(metricStreamPublisher.publishRows.mock.calls[0]?.[0]).toHaveLength(4000);
      expect(metricStreamPublisher.publishRows.mock.calls[1]?.[0]).toHaveLength(1000);
    });
  });
});
