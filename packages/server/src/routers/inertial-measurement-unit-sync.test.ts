import { captureException } from "dofek/lib/error-reporting";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory, makeTransactionalTestDatabase } from "./test-helpers.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const { mockSpan, mockStartActiveSpan } = vi.hoisted(() => {
  const span = {
    end: vi.fn(),
    recordException: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
  };
  return {
    mockSpan: span,
    mockStartActiveSpan: vi.fn((_name, optionsOrCallback, maybeCallback) => {
      const callback = maybeCallback ?? optionsOrCallback;
      return callback(span);
    }),
  };
});

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
}));

vi.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { OK: 1, ERROR: 2 },
  trace: {
    getTracer: vi.fn(() => ({
      startActiveSpan: mockStartActiveSpan,
    })),
  },
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; metricStreamPublisher?: unknown; userId: string | null }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

import { logger } from "../logger.ts";
import { inertialMeasurementUnitSyncRouter } from "./inertial-measurement-unit-sync.ts";

const createCaller = createTestCallerFactory(inertialMeasurementUnitSyncRouter);

function makeExecute() {
  return vi.fn(async () => []);
}

function makeDatabase(execute = makeExecute()) {
  return makeTransactionalTestDatabase({ execute });
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
  beforeEach(() => {
    vi.mocked(captureException).mockReset();
    mockSpan.end.mockReset();
    mockSpan.recordException.mockReset();
    mockSpan.setAttributes.mockReset();
    mockSpan.setStatus.mockReset();
    mockStartActiveSpan.mockReset();
  });

  describe("pushSamples", () => {
    it("publishes accel samples", async () => {
      const execute = makeExecute();
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      const nowSpy = vi.spyOn(performance, "now");
      nowSpy.mockReturnValueOnce(1000);
      nowSpy.mockReturnValueOnce(1005);
      nowSpy.mockReturnValueOnce(1005);
      nowSpy.mockReturnValueOnce(1020);

      const result = await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [makeSample(), makeSample({ timestamp: "2026-03-25T10:00:00.040Z", x: 0.015 })],
      });

      nowSpy.mockRestore();

      expect(result.inserted).toBe(2);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(1);
      expect(mockStartActiveSpan).toHaveBeenCalledWith(
        "imu.pushSamples",
        expect.objectContaining({
          attributes: expect.objectContaining({
            "imu.sampleCount": 2,
            "imu.deviceId": "iPhone 15 Pro",
          }),
        }),
        expect.any(Function),
      );
      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "imu.ensureProviderMs": 5,
          "imu.insertBatchMs": 15,
          "imu.totalMs": 20,
          "imu.sampleCount": 2,
          "imu.filteredCount": 0,
        }),
      );
      expect(mockSpan.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "imu.batchOffset": expect.any(Number),
          "imu.batchRowCount": expect.any(Number),
        }),
      );
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
      expect(mockSpan.setStatus.mock.calls.map((c) => c[0])).toEqual([{ code: 1 }, { code: 1 }]);
      expect(mockSpan.end).toHaveBeenCalledTimes(2);
      expect(getPublishedRows(metricStreamPublisher)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: "apple_motion",
            externalId: "apple_motion:iPhone 15 Pro:accel:2026-03-25T10:00:00.020Z",
            channel: "accel",
            vector: [0.012, -0.981, 0.043],
          }),
          expect.objectContaining({
            externalId: "apple_motion:iPhone 15 Pro:accel:2026-03-25T10:00:00.040Z",
            vector: [0.015, -0.981, 0.043],
          }),
        ]),
      );
    });

    it("publishes samples through Redpanda without inserting metric stream rows into Postgres", async () => {
      const execute = vi.fn(async () => []);
      const metricStreamPublisher = {
        publishRows: vi.fn(async (rows: readonly unknown[]) =>
          rows.map((_, index) => ({ id: `event-${index}` })),
        ),
      };
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "00000000-0000-0000-0000-000000000001",
      });

      const result = await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [makeSample()],
      });

      expect(result.inserted).toBe(1);
      expect(JSON.stringify(execute.mock.calls)).not.toContain("fitness.metric_stream");
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            userId: "00000000-0000-0000-0000-000000000001",
            providerId: "apple_motion",
            channel: "accel",
            vector: [0.012, -0.981, 0.043],
          }),
        ],
        { operationRevision: "1000000000000000" },
      );
    });

    it("writes deterministic external IDs and treats duplicate samples as no-ops", async () => {
      const execute = makeExecute();
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [makeSample({ timestamp: "2026-03-25T10:00:00.020+00:00" })],
      });

      expect(getPublishedRows(metricStreamPublisher)).toContainEqual(
        expect.objectContaining({
          externalId: "apple_motion:iPhone 15 Pro:accel:2026-03-25T10:00:00.020Z",
        }),
      );
    });

    it("handles empty samples array by returning zero inserted", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: makeDatabase(execute), userId: "user-1" });

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
      expect(mockStartActiveSpan).not.toHaveBeenCalled();
    });

    it("returns zero inserted when duplicate IMU rows no-op", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const metricStreamPublisher = {
        publishRows: vi.fn(async () => []),
      };
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      const result = await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples: [makeSample()],
      });

      expect(result.inserted).toBe(0);
    });

    it("rejects samples with missing required fields", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: makeDatabase(execute), userId: "user-1" });

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
      const caller = createCaller({ db: makeDatabase(execute), userId: "user-1" });

      await expect(
        caller.pushSamples({
          deviceId: "",
          deviceType: "iphone",
          samples: [makeSample()],
        }),
      ).rejects.toThrow();
    });

    it("filters out samples more than five minutes in the future", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-25T10:00:00.000Z"));

      const execute = makeExecute();
      const caller = createCaller({ db: makeDatabase(execute), userId: "user-1" });

      try {
        const result = await caller.pushSamples({
          deviceId: "WHOOP Strap",
          deviceType: "whoop",
          samples: [makeSample({ timestamp: "2026-03-25T10:06:00.001Z" })],
        });

        expect(result.inserted).toBe(0);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(mockSpan.setAttributes).toHaveBeenCalledWith(
          expect.objectContaining({ "imu.filteredCount": 1 }),
        );
        expect(logger.info).toHaveBeenCalledWith(
          "IMU samples pushed",
          expect.objectContaining({ filteredCount: 1 }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("filters out malformed sample timestamps", async () => {
      const execute = makeExecute();
      const caller = createCaller({ db: makeDatabase(execute), userId: "user-1" });

      const result = await caller.pushSamples({
        deviceId: "WHOOP Strap",
        deviceType: "whoop",
        samples: [makeSample({ timestamp: "not-a-timestamp" })],
      });

      expect(result.inserted).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("batches large sample arrays into multiple INSERT statements", async () => {
      const startTimestamp = new Date("2026-03-25T10:00:00.020Z");
      const execute = makeExecute();
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      const samples = Array.from({ length: 7500 }, (_, index) =>
        makeSample({
          timestamp: new Date(startTimestamp.getTime() + index * 20).toISOString(),
        }),
      );

      const result = await caller.pushSamples({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples,
      });

      expect(result.inserted).toBe(7500);
      expect(execute).toHaveBeenCalledTimes(5);
      expect(metricStreamPublisher.publishRows).toHaveBeenCalledTimes(2);
      expect(metricStreamPublisher.publishRows.mock.calls[0]?.[0]).toHaveLength(5000);
      expect(metricStreamPublisher.publishRows.mock.calls[1]?.[0]).toHaveLength(2500);
    });

    it("accepts samples with optional gyroscope fields", async () => {
      const execute = makeExecute();
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

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
      expect(execute).toHaveBeenCalledTimes(3);
      expect(getPublishedRows(metricStreamPublisher)).toContainEqual(
        expect.objectContaining({
          channel: "imu",
          recordedAt: "2026-03-25T10:00:00.020Z",
          vector: [0.012, -0.981, 0.043, 0.15, -0.22, 0.08],
        }),
      );
    });

    it("accepts a mix of samples with and without gyroscope", async () => {
      const execute = makeExecute();
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

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
      expect(execute).toHaveBeenCalledTimes(3);
      const publishedRows = getPublishedRows(metricStreamPublisher);
      expect(publishedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channel: "accel", vector: [0.012, -0.981, 0.043] }),
          expect.objectContaining({
            channel: "imu",
            vector: [0.012, -0.981, 0.043, 0.1, 0.2, 0.3],
          }),
        ]),
      );
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
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      await caller.pushSamples({
        deviceId: "Apple Watch",
        deviceType: "apple_watch",
        samples: [makeSample(overrides)],
      });

      const [publishedRow] = getPublishedRows(metricStreamPublisher);
      expect(publishedRow).toEqual(
        expect.objectContaining({
          channel: "imu",
          vector: [0.012, -0.981, 0.043, ...expectedGyroValues],
        }),
      );
    });

    it("logs the full timestamp range for successful pushes", async () => {
      const execute = makeExecute();
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });
      const nowSpy = vi.spyOn(performance, "now");
      nowSpy.mockReturnValueOnce(100);
      nowSpy.mockReturnValueOnce(112);
      nowSpy.mockReturnValueOnce(112);
      nowSpy.mockReturnValueOnce(150);

      try {
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
            ensureProviderMs: 12,
            insertBatchMs: 38,
            totalMs: 50,
          }),
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("reports failures to Sentry with the imu-push-samples source tag", async () => {
      const dbError = new Error("connection refused");
      const execute = vi.fn().mockRejectedValue(dbError);
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      await expect(
        caller.pushSamples({
          deviceId: "iPhone 15 Pro",
          deviceType: "iphone",
          samples: [makeSample()],
        }),
      ).rejects.toThrow("connection refused");

      const ensureError = expect.objectContaining({
        message: expect.stringContaining("ensureProvider(apple_motion) failed"),
        cause: dbError,
      });
      expect(captureException).toHaveBeenCalledWith(ensureError, {
        tags: { source: "imu-push-samples" },
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(ensureError);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: 2,
        message: expect.stringContaining("ensureProvider(apple_motion) failed"),
      });
    });

    it("reports publish failures from the repository to Sentry", async () => {
      const publishError = new Error("redpanda offline");
      const metricStreamPublisher = {
        publishRows: vi.fn().mockRejectedValue(publishError),
      };
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      await expect(
        caller.pushSamples({
          deviceId: "WHOOP Strap",
          deviceType: "whoop",
          samples: [makeSample()],
        }),
      ).rejects.toThrow("redpanda offline");

      expect(captureException).toHaveBeenCalledWith(publishError, {
        tags: { source: "imu-push-samples" },
      });
      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: 2,
        message: "redpanda offline",
      });
      expect(mockSpan.recordException).toHaveBeenCalledTimes(2);
    });

    it("handles non-Error publish failures from the repository", async () => {
      const metricStreamPublisher = {
        publishRows: vi.fn().mockRejectedValue("string error"),
      };
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      await expect(
        caller.pushSamples({
          deviceId: "WHOOP Strap",
          deviceType: "whoop",
          samples: [makeSample()],
        }),
      ).rejects.toThrow("string error");

      expect(captureException).toHaveBeenCalledWith("string error", {
        tags: { source: "imu-push-samples" },
      });
      expect(mockSpan.recordException).not.toHaveBeenCalled();
    });

    it("reports non-Error thrown values to Sentry and span", async () => {
      const stringError = "something went wrong";
      const execute = vi.fn().mockRejectedValue(stringError);
      const metricStreamPublisher = makeMetricStreamPublisher();
      const caller = createCaller({
        db: makeDatabase(execute),
        metricStreamPublisher,
        userId: "user-1",
      });

      await expect(
        caller.pushSamples({
          deviceId: "iPhone 15 Pro",
          deviceType: "iphone",
          samples: [makeSample()],
        }),
      ).rejects.toThrow(stringError);

      const ensureError = expect.objectContaining({
        message: expect.stringContaining("ensureProvider(apple_motion) failed"),
        cause: stringError,
      });
      expect(captureException).toHaveBeenCalledWith(ensureError, {
        tags: { source: "imu-push-samples" },
      });
      expect(mockSpan.recordException).toHaveBeenCalledWith(ensureError);
    });
  });
});
