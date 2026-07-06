import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

import { watchAltitudeSyncRouter } from "./watch-altitude-sync.ts";

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

function makeCtx(database = makeMockDb(), metricStreamPublisher = makeMetricStreamPublisher()) {
  return {
    db: database,
    metricStreamPublisher,
    userId: "test-user-id",
    timezone: "America/New_York",
  };
}

describe("watchAltitudeSyncRouter", () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let metricStreamPublisher: ReturnType<typeof makeMetricStreamPublisher>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    mockDb = makeMockDb();
    metricStreamPublisher = makeMetricStreamPublisher();
    ctx = makeCtx(mockDb, metricStreamPublisher);
  });

  describe("pushSamples", () => {
    const caller = watchAltitudeSyncRouter.createCaller;

    it("returns zero inserted for empty samples array", async () => {
      const result = await caller(ctx).pushSamples({
        deviceId: "Apple Watch",
        samples: [],
      });

      expect(result).toEqual({ inserted: 0 });
    });

    it("ensures the apple_motion provider exists before publishing", async () => {
      await caller(ctx).pushSamples({
        deviceId: "Apple Watch",
        samples: [{ timestamp: "2026-03-30T12:00:00.000Z", altitudeM: 12.5 }],
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockDb.execute.mock.calls)).toContain("apple_motion");
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(1);
    });

    it("publishes an altitude scalar row through the metric stream", async () => {
      const result = await caller(ctx).pushSamples({
        deviceId: "Apple Watch",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            altitudeM: 12.5,
            pressureKPa: 98.2,
          },
        ],
      });

      expect(result).toEqual({ inserted: 1 });
      expect(getPublishedRows(metricStreamPublisher)).toEqual([
        expect.objectContaining({
          providerId: "apple_motion",
          channel: "altitude",
          deviceId: "Apple Watch",
          recordedAt: "2026-03-30T12:00:00.000Z",
          scalar: 12.5,
          metadata: { pressure_kpa: 98.2 },
          externalId: "apple_motion:Apple Watch:altitude:2026-03-30T12:00:00.000Z",
        }),
      ]);
    });

    it("filters future-dated samples", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

      try {
        const result = await caller(ctx).pushSamples({
          deviceId: "Apple Watch",
          samples: [
            { timestamp: "2026-03-30T12:00:00.000Z", altitudeM: 5 },
            { timestamp: "2026-03-30T12:06:00.001Z", altitudeM: 999 },
          ],
        });

        expect(result).toEqual({ inserted: 1 });
        expect(getPublishedRows(metricStreamPublisher)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
