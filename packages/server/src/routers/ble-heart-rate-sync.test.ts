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

import { bleHeartRateSyncRouter } from "./ble-heart-rate-sync.ts";

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

describe("bleHeartRateSyncRouter", () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let metricStreamPublisher: ReturnType<typeof makeMetricStreamPublisher>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    mockDb = makeMockDb();
    metricStreamPublisher = makeMetricStreamPublisher();
    ctx = makeCtx(mockDb, metricStreamPublisher);
  });

  describe("pushSamples", () => {
    const caller = bleHeartRateSyncRouter.createCaller;

    it("returns zero inserted for empty samples array", async () => {
      const result = await caller(ctx).pushSamples({
        deviceId: "Polar H10",
        samples: [],
      });

      expect(result).toEqual({ inserted: 0 });
    });

    it("ensures the ble_heart_rate provider exists before publishing", async () => {
      await caller(ctx).pushSamples({
        deviceId: "Polar H10",
        samples: [{ timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: 142, rrIntervalsMs: [] }],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(mockDb.execute.mock.calls)).toContain("ble_heart_rate");
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(1);
      expect(mockDb.execute.mock.invocationCallOrder[0]).toBeLessThan(
        metricStreamPublisher.publishRows.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("publishes a heart_rate scalar row through the metric stream", async () => {
      const result = await caller(ctx).pushSamples({
        deviceId: "Polar H10",
        samples: [{ timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: 142, rrIntervalsMs: [] }],
      });

      expect(result).toEqual({ inserted: 1 });
      expect(JSON.stringify(mockDb.execute.mock.calls)).not.toContain("fitness.metric_stream");
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({
          providerId: "ble_heart_rate",
          channel: "heart_rate",
          deviceId: "Polar H10",
          sourceType: "ble",
          recordedAt: "2026-03-30T12:00:00.000Z",
          scalar: 142,
          externalId: "ble_heart_rate:Polar H10:heart_rate:2026-03-30T12:00:00.000Z",
        }),
      ]);
    });

    it("skips zero-bpm readings (strap not yet detecting contact)", async () => {
      const result = await caller(ctx).pushSamples({
        deviceId: "Polar H10",
        samples: [{ timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: 0, rrIntervalsMs: [] }],
      });

      expect(result).toEqual({ inserted: 0 });
      expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
    });

    it("publishes each R-R interval as its own rr_interval_ms row with distinct external IDs", async () => {
      await caller(ctx).pushSamples({
        deviceId: "Polar H10",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRateBpm: 60,
            rrIntervalsMs: [1000, 998],
          },
        ],
      });

      const rows = getPublishedRows(metricStreamPublisher);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channel: "heart_rate", scalar: 60 }),
          expect.objectContaining({
            channel: "rr_interval_ms",
            scalar: 1000,
            externalId: "ble_heart_rate:Polar H10:rr_interval_ms:2026-03-30T12:00:00.000Z:0",
          }),
          expect.objectContaining({
            channel: "rr_interval_ms",
            scalar: 998,
            externalId: "ble_heart_rate:Polar H10:rr_interval_ms:2026-03-30T12:00:00.000Z:1",
          }),
        ]),
      );
    });

    it("defaults rrIntervalsMs to an empty array when omitted", async () => {
      const result = await caller(ctx).pushSamples({
        deviceId: "Wahoo TICKR",
        samples: [{ timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: 88 }],
      });

      expect(result).toEqual({ inserted: 1 });
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({ channel: "heart_rate", scalar: 88 }),
      ]);
    });

    it("logs timestamps and sample count on successful push", async () => {
      const { logger } = await import("../logger.ts");
      await caller(ctx).pushSamples({
        deviceId: "Polar H10",
        samples: [
          { timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: 140, rrIntervalsMs: [] },
          { timestamp: "2026-03-30T12:00:01.000Z", heartRateBpm: 141, rrIntervalsMs: [] },
        ],
      });

      expect(logger.info).toHaveBeenCalledWith(
        "BLE heart-rate data pushed",
        expect.objectContaining({
          userId: "test-user-id",
          deviceId: "Polar H10",
          sampleCount: 2,
          firstTimestamp: "2026-03-30T12:00:00.000Z",
          lastTimestamp: "2026-03-30T12:00:01.000Z",
        }),
      );
    });

    it("returns zero inserted when duplicate rows no-op", async () => {
      metricStreamPublisher.publishRows.mockResolvedValue([]);

      const result = await caller(ctx).pushSamples({
        deviceId: "Polar H10",
        samples: [{ timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: 142, rrIntervalsMs: [] }],
      });

      expect(result).toEqual({ inserted: 0 });
      expect(mockDb.execute).toHaveBeenCalledTimes(3);
    });

    it("rejects heart rate values above the physiological ceiling", async () => {
      await expect(
        caller(ctx).pushSamples({
          deviceId: "Polar H10",
          samples: [
            { timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: 301, rrIntervalsMs: [] },
          ],
        }),
      ).rejects.toThrow();
    });

    it("rejects missing deviceId", async () => {
      await expect(caller(ctx).pushSamples({ deviceId: "", samples: [] })).rejects.toThrow();
    });

    it("rejects a non-ISO timestamp at the input boundary", async () => {
      await expect(
        caller(ctx).pushSamples({
          deviceId: "Polar H10",
          samples: [{ timestamp: "not-a-timestamp", heartRateBpm: 142, rrIntervalsMs: [] }],
        }),
      ).rejects.toThrow();
      expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
    });

    it("filters out samples more than five minutes in the future", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

      try {
        const result = await caller(ctx).pushSamples({
          deviceId: "Polar H10",
          samples: [
            { timestamp: "2026-03-30T12:06:00.001Z", heartRateBpm: 142, rrIntervalsMs: [] },
          ],
        });

        expect(result.inserted).toBe(0);
        expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports the count of samples dropped as being in the future", async () => {
      const { logger } = await import("../logger.ts");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

      try {
        await caller(ctx).pushSamples({
          deviceId: "Polar H10",
          samples: [
            { timestamp: "2026-03-30T11:59:59.000Z", heartRateBpm: 140, rrIntervalsMs: [] },
            { timestamp: "2026-03-30T12:06:00.001Z", heartRateBpm: 142, rrIntervalsMs: [] },
          ],
        });

        // One valid + one future-filtered → filteredCount must be 2 - 1 = 1.
        expect(logger.info).toHaveBeenCalledWith(
          "BLE heart-rate data pushed",
          expect.objectContaining({ sampleCount: 1, filteredCount: 1 }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("handles batch splitting for large sample arrays", async () => {
      const samples = Array.from({ length: 2500 }, (_, index) => ({
        timestamp: new Date(1711800000000 + index * 1000).toISOString(),
        heartRateBpm: 140,
        rrIntervalsMs: [],
      }));

      const result = await caller(ctx).pushSamples({ deviceId: "Polar H10", samples });

      expect(result).toEqual({ inserted: 2500 });
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(2);
      expect(metricStreamPublisher.publishRows.mock.calls[0]?.[0]).toHaveLength(2000);
      expect(metricStreamPublisher.publishRows.mock.calls[1]?.[0]).toHaveLength(500);
    });
  });
});
