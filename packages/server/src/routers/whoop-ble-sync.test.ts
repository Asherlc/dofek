import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

// Mock logger
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

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

import { captureException } from "dofek/lib/error-reporting";
import { logger } from "../logger.ts";
import { whoopBleSyncRouter } from "./whoop-ble-sync.ts";

function makeMockDb() {
  return makeTransactionalTestDatabase({
    execute: vi.fn(async () => []),
  });
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

function makeCtx(database = makeMockDb(), metricStreamPublisher = makeMetricStreamPublisher()) {
  return {
    db: database,
    metricStreamPublisher,
    userId: "test-user-id",
    timezone: "America/New_York",
  };
}

describe("whoopBleSyncRouter", () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let metricStreamPublisher: ReturnType<typeof makeMetricStreamPublisher>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    mockDb = makeMockDb();
    metricStreamPublisher = makeMetricStreamPublisher();
    ctx = makeCtx(mockDb, metricStreamPublisher);
  });

  describe("pushRealtimeData", () => {
    const caller = whoopBleSyncRouter.createCaller;

    it("correlates receipt and publication after broker acknowledgment without logging sensor values", async () => {
      let acknowledge!: () => void;
      const acknowledgment = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      metricStreamPublisher.publishRows.mockImplementation(async (rows) => {
        await acknowledgment;
        return rows.map((_, index) => ({ id: `event-${index}` }));
      });
      const telemetry = {
        batchId: "268dc563-bc67-4d37-8ff1-0067a7f7ce85",
        bufferInstanceId: "9a5b18b9-6037-47b7-ac55-fc2484191178",
      };
      const upload = caller({
        ...ctx,
        appVersion: "1.12.0",
        assetsVersion: "ota-1",
      }).pushRealtimeData({
        deviceId: "WHOOP Strap",
        telemetry,
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRateBpm: 72,
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });
      await vi.waitFor(() => expect(metricStreamPublisher.publishRows).toHaveBeenCalledOnce());
      const attributes = {
        ...telemetry,
        userId: "test-user-id",
        deviceId: "WHOOP Strap",
        appVersion: "1.12.0",
        assetsVersion: "ota-1",
        inputSampleCount: 1,
        acceptedSampleCount: 1,
        filteredSampleCount: 0,
      };
      expect(logger.info).toHaveBeenCalledWith(
        "[sensor-upload] upload_received",
        expect.objectContaining(attributes),
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        "[sensor-upload] upload_published",
        expect.objectContaining(telemetry),
      );
      acknowledge();
      await expect(upload).resolves.toEqual({ inserted: 2 });
      expect(logger.info).toHaveBeenCalledWith(
        "[sensor-upload] upload_published",
        expect.objectContaining({
          ...attributes,
          publishedRowCount: 2,
          boundary: "redpanda",
        }),
      );
    });

    it("correlates a rejected publish and reports the original exception", async () => {
      const publishError = new Error("broker unavailable");
      metricStreamPublisher.publishRows.mockRejectedValueOnce(publishError);
      const telemetry = { batchId: "7f25e8cf-c346-42b1-9c2a-9c37af2f45e6" };
      await expect(
        caller(ctx).pushRealtimeData({
          deviceId: "WHOOP Strap",
          telemetry,
          samples: [
            {
              timestamp: "2026-03-30T12:00:00Z",
              heartRateBpm: 72,
              quaternionW: 0,
              quaternionX: 0,
              quaternionY: 0,
              quaternionZ: 0,
            },
          ],
        }),
      ).rejects.toMatchObject({ cause: publishError });
      expect(logger.error).toHaveBeenCalledWith(
        "[sensor-upload] upload_failed",
        expect.objectContaining(telemetry),
      );
      expect(captureException).toHaveBeenCalledWith(
        publishError,
        expect.objectContaining({ extra: expect.objectContaining(telemetry) }),
      );
    });

    it("returns zero inserted for empty samples array", async () => {
      const trpcCaller = caller(ctx);
      const telemetry = { batchId: "336eb233-4bca-4b70-bb91-22a55f131917" };
      const result = await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [],
        telemetry,
      });

      expect(result).toEqual({ inserted: 0 });
      expect(logger.info).toHaveBeenCalledWith(
        "[sensor-upload] upload_published",
        expect.objectContaining({
          ...telemetry,
          boundary: "no_metric_rows",
          inputSampleCount: 0,
          acceptedSampleCount: 0,
          filteredSampleCount: 0,
          publishedRowCount: 0,
        }),
      );
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

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(1);
      expect(mockDb.execute.mock.invocationCallOrder[0]).toBeLessThan(
        metricStreamPublisher.publishRows.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("publishes realtime data through Redpanda without inserting metric stream rows into Postgres", async () => {
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
      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(mockDb.execute.mock.calls)).not.toContain("fitness.metric_stream");
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledWith(
        [
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
        ],
        { operationRevision: "1000000000000000" },
      );
    });

    it("stores intervals when reported heart rate is not supplied", async () => {
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

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({
          channel: "rr_interval_ms",
          scalar: 812,
        }),
      ]);
      expect(JSON.stringify(getPublishedRows(metricStreamPublisher))).not.toContain("heart_rate");
    });

    it("writes deterministic external IDs and treats duplicate realtime samples as no-ops", async () => {
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRateBpm: 72,
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0.5,
            quaternionY: 0,
            quaternionZ: 0,
          },
        ],
      });

      const publishedRows = getPublishedRows(metricStreamPublisher);

      expect(publishedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalId: "whoop_ble:WHOOP Strap:heart_rate:2026-03-30T12:00:00.000Z",
          }),
          expect.objectContaining({
            externalId: "whoop_ble:WHOOP Strap:rr_interval_ms:2026-03-30T12:00:00.000Z",
          }),
          expect.objectContaining({
            externalId: "whoop_ble:WHOOP Strap:orientation:2026-03-30T12:00:00.000Z",
          }),
        ]),
      );
    });

    it("retains reported heart rate alongside raw beat intervals", async () => {
      const trpcCaller = caller(ctx);
      const sample = {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 72,
        rrIntervalMs: 812,
        quaternionW: 0,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
      };

      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [sample],
      });

      const publishedRows = getPublishedRows(metricStreamPublisher);
      expect(publishedRows).toEqual([
        expect.objectContaining({
          channel: "heart_rate",
          scalar: 72,
          sourceType: "ble",
          deviceId: "WHOOP Strap",
          providerId: "whoop_ble",
          externalId: "whoop_ble:WHOOP Strap:heart_rate:2026-03-30T12:00:00.000Z",
        }),
        expect.objectContaining({
          channel: "rr_interval_ms",
          scalar: 812,
        }),
      ]);
    });

    it("retains reported heart rate when the strap has no beat intervals", async () => {
      const sample = {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 128,
        rrIntervalMs: 0,
        quaternionW: 0,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
      };

      const result = await caller(ctx).pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [sample],
      });

      expect(result).toEqual({ inserted: 1 });
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "heart_rate", scalar: 128 }),
      ]);
    });

    it("retains intervals when the reported heart rate is unavailable", async () => {
      const sample = {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 0,
        rrIntervalMs: 812,
        quaternionW: 0,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
      };

      await caller(ctx).pushRealtimeData({ deviceId: "WHOOP Strap", samples: [sample] });

      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "rr_interval_ms", scalar: 812 }),
      ]);
    });

    it.each([-1, 72.5, 256])("rejects invalid reported heart rate %s", async (heartRateBpm) => {
      await expect(
        caller(ctx).pushRealtimeData({
          deviceId: "WHOOP Strap",
          samples: [
            {
              timestamp: "2026-03-30T12:00:00.000Z",
              heartRateBpm,
              quaternionW: 0,
              quaternionX: 0,
              quaternionY: 0,
              quaternionZ: 0,
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it("inserts orientation data into metric stream", async () => {
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

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "rr_interval_ms" }),
      ]);
    });

    it("inserts R-R interval samples when samples include rrIntervalMs", async () => {
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

      expect(mockDb.execute).toHaveBeenCalledTimes(3);

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

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "orientation", vector: [0, 0.5, 0, 0] }),
      ]);
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

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "orientation", vector: [0, 0, 0.5, 0] }),
      ]);
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

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "orientation", vector: [0, 0, 0, 0.5] }),
      ]);
    });

    it("logs chronological timestamp bounds and sample count for an unordered push", async () => {
      const { logger } = await import("../logger.ts");
      const trpcCaller = caller(ctx);
      await trpcCaller.pushRealtimeData({
        deviceId: "WHOOP Strap",
        samples: [
          {
            timestamp: "2026-03-30T12:00:01.000Z",
            rrIntervalMs: 812,
            quaternionW: 0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
          },
          {
            timestamp: "2026-03-30T12:00:00.000Z",
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
      metricStreamPublisher.publishRows.mockResolvedValue([]);
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
      expect(mockDb.execute).toHaveBeenCalledTimes(3);
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

    it("filters out samples more than five minutes in the future", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

      const trpcCaller = caller(ctx);
      const telemetry = { batchId: "41176483-7baa-42fe-8003-353c43ed5a26" };

      try {
        const result = await trpcCaller.pushRealtimeData({
          deviceId: "WHOOP Strap",
          telemetry,
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
        });

        expect(result.inserted).toBe(0);
        expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
          "[sensor-upload] upload_published",
          expect.objectContaining({
            ...telemetry,
            boundary: "no_metric_rows",
            inputSampleCount: 1,
            acceptedSampleCount: 0,
            filteredSampleCount: 1,
            publishedRowCount: 0,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("filters out malformed sample timestamps", async () => {
      const trpcCaller = caller(ctx);

      const result = await trpcCaller.pushRealtimeData({
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
      });

      expect(result.inserted).toBe(0);
      expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
    });

    it("handles batch splitting for large sample arrays", async () => {
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
      expect(mockDb.execute).toHaveBeenCalledTimes(5);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(2);
      expect(metricStreamPublisher.publishRows.mock.calls[0]?.[0]).toHaveLength(4000);
      expect(metricStreamPublisher.publishRows.mock.calls[1]?.[0]).toHaveLength(1000);
    });
  });
});
