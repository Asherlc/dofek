import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";

const { mockLoggerInfo, mockSpan, mockStartActiveSpan } = vi.hoisted(() => {
  const span = {
    end: vi.fn(),
    setAttribute: vi.fn(),
  };
  return {
    mockLoggerInfo: vi.fn(),
    mockSpan: span,
    mockStartActiveSpan: vi.fn((_name, callback) => callback(span)),
  };
});

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: vi.fn(() => ({
      startActiveSpan: mockStartActiveSpan,
    })),
  },
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: mockLoggerInfo,
  },
}));

import { LimitedActivitySensorStore } from "./limited-activity-sensor-store.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makeSensorWindow(): ActivitySensorWindow {
  return {
    activityId: "activity-1",
    userId: "user-1",
    startedAt: "2026-03-01T10:00:00Z",
    endedAt: "2026-03-01T11:00:00Z",
    memberActivityIds: [],
  };
}

function makeDelegate(overrides: Partial<ActivitySensorStore>): ActivitySensorStore {
  return {
    query: vi.fn().mockResolvedValue([]),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("LimitedActivitySensorStore", () => {
  it("emits queue wait telemetry fields without health data", async () => {
    const delegate = makeDelegate({
      query: vi.fn().mockResolvedValue([{ value: 1 }]),
    });
    const store = new LimitedActivitySensorStore(delegate, 1);

    await store.query(
      z.object({ value: z.number() }),
      "SELECT value FROM analytics.daily_recovery WHERE user_id = {userId:String}",
      { userId: "user-1" },
      { priority: "dashboard" },
    );

    expect(mockStartActiveSpan).toHaveBeenCalledWith("clickhouse.queue_wait", expect.any(Function));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("clickhouse.queue.name", "dashboard");
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("clickhouse.queue.concurrency", 2);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("clickhouse.queue.active", 0);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("clickhouse.queue.depth", 0);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "clickhouse.queue.wait_ms",
      expect.toSatisfy((val: number) => val >= 0 && val < 1000),
    );
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const loggedQueueWait = mockLoggerInfo.mock.calls[0]?.[1];
    expect(loggedQueueWait).toEqual({
      active: 0,
      concurrency: 2,
      depth: 0,
      queue: "dashboard",
      waitMs: expect.toSatisfy((val: number) => val >= 0 && val < 1000),
    });
    expect(Object.keys(loggedQueueWait).sort()).toEqual([
      "active",
      "concurrency",
      "depth",
      "queue",
      "waitMs",
    ]);
  });

  it("starts explicitly prioritized dashboard queries while regular work is queued", async () => {
    const events: string[] = [];
    const stream = deferred<StreamPointRow[]>();
    const dashboardRows = deferred<Array<{ value: number }>>();
    const delegate = makeDelegate({
      getStream: vi.fn(() => {
        events.push("stream-started");
        return stream.promise;
      }),
      query: vi.fn(() => {
        events.push("dashboard-started");
        return dashboardRows.promise;
      }),
    });
    const store = new LimitedActivitySensorStore(delegate, 1);

    const streamPromise = store.getStream(makeSensorWindow(), 500);
    await Promise.resolve();
    const dashboardPromise = store.query(
      z.object({ value: z.number() }),
      "SELECT value FROM analytics.some_new_dashboard_table",
      {},
      { priority: "dashboard" },
    );
    for (let microtaskTurn = 0; microtaskTurn < 5; microtaskTurn += 1) {
      await Promise.resolve();
    }

    const dashboardStartedBeforeRegularRelease = events.includes("dashboard-started");
    stream.resolve([]);
    dashboardRows.resolve([{ value: 1 }]);
    await Promise.all([streamPromise, dashboardPromise]);

    expect(dashboardStartedBeforeRegularRelease).toBe(true);
  });

  it("queues regular queries even when their SQL mentions dashboard tables", async () => {
    const events: string[] = [];
    const stream = deferred<StreamPointRow[]>();
    const dashboardRows = deferred<Array<{ value: number }>>();
    const delegate = makeDelegate({
      getStream: vi.fn(() => {
        events.push("stream-started");
        return stream.promise;
      }),
      query: vi.fn(() => {
        events.push("query-started");
        return dashboardRows.promise;
      }),
    });
    const store = new LimitedActivitySensorStore(delegate, 1);

    const streamPromise = store.getStream(makeSensorWindow(), 500);
    await Promise.resolve();
    const queryPromise = store.query(
      z.object({ value: z.number() }),
      "SELECT value FROM analytics.daily_recovery",
    );
    for (let microtaskTurn = 0; microtaskTurn < 5; microtaskTurn += 1) {
      await Promise.resolve();
    }

    const queryStartedBeforeRegularRelease = events.includes("query-started");
    stream.resolve([]);
    dashboardRows.resolve([{ value: 1 }]);
    await Promise.all([streamPromise, queryPromise]);

    expect(queryStartedBeforeRegularRelease).toBe(false);
  });

  it("deduplicates identical in-flight queries with the same priority", async () => {
    const rows = deferred<Array<{ value: number }>>();
    const delegate = makeDelegate({
      query: vi.fn(() => rows.promise),
    });
    const store = new LimitedActivitySensorStore(delegate, 1);
    const schema = z.object({ value: z.number() });
    const query = "SELECT value FROM analytics.daily_recovery WHERE user_id = {userId:String}";
    const params = { userId: "user-1" };

    const dashboardPromise = store.query(schema, query, params, { priority: "dashboard" });
    const secondDashboardPromise = store.query(schema, query, params, { priority: "dashboard" });
    for (let microtaskTurn = 0; microtaskTurn < 5; microtaskTurn += 1) {
      await Promise.resolve();
    }

    expect(delegate.query).toHaveBeenCalledTimes(1);

    rows.resolve([{ value: 1 }]);

    await expect(dashboardPromise).resolves.toEqual([{ value: 1 }]);
    await expect(secondDashboardPromise).resolves.toEqual([{ value: 1 }]);
  });

  it("does not create an unhandled rejection when a cached in-flight query rejects", async () => {
    const clickHouseError = new Error("Timeout error.");
    const delegate = makeDelegate({
      query: vi.fn().mockRejectedValue(clickHouseError),
    });
    const store = new LimitedActivitySensorStore(delegate, 1);
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(store.query(z.object({ value: z.number() }), "SELECT value")).rejects.toThrow(
        "Timeout error.",
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("does not attach dashboard-priority reads to regular in-flight work", async () => {
    const rows = deferred<Array<{ value: number }>>();
    const delegate = makeDelegate({
      query: vi.fn(() => rows.promise),
    });
    const store = new LimitedActivitySensorStore(delegate, 1);
    const schema = z.object({ value: z.number() });
    const query = "SELECT value FROM analytics.daily_recovery WHERE user_id = {userId:String}";
    const params = { userId: "user-1" };

    const regularPromise = store.query(schema, query, params);
    const dashboardPromise = store.query(schema, query, params, { priority: "dashboard" });
    expect(regularPromise).not.toBe(dashboardPromise);
    for (let microtaskTurn = 0; microtaskTurn < 5; microtaskTurn += 1) {
      await Promise.resolve();
    }

    expect(delegate.query).toHaveBeenCalledTimes(2);

    rows.resolve([{ value: 1 }]);

    await expect(regularPromise).resolves.toEqual([{ value: 1 }]);
    await expect(dashboardPromise).resolves.toEqual([{ value: 1 }]);
  });

  it("does not deduplicate abortable readiness queries with regular in-flight queries", async () => {
    const sharedRows = deferred<Array<{ value: number }>>();
    const abortableRows = deferred<Array<{ value: number }>>();
    const delegate = makeDelegate({
      query: vi.fn((_schema, _query, _params, options) =>
        options?.abortSignal ? abortableRows.promise : sharedRows.promise,
      ),
    });
    const store = new LimitedActivitySensorStore(delegate, 2);
    const schema = z.object({ value: z.number() });
    const abortController = new AbortController();

    const regularPromise = store.query(schema, "SELECT value");
    await Promise.resolve();
    const abortablePromise = store.query(schema, "SELECT value", undefined, {
      abortSignal: abortController.signal,
    });
    await Promise.resolve();
    sharedRows.resolve([{ value: 1 }]);
    abortableRows.resolve([{ value: 2 }]);

    await expect(regularPromise).resolves.toEqual([{ value: 1 }]);
    await expect(abortablePromise).resolves.toEqual([{ value: 2 }]);
    expect(delegate.query).toHaveBeenCalledTimes(2);
    expect(delegate.query).toHaveBeenNthCalledWith(
      2,
      schema,
      "SELECT value",
      {},
      {
        abortSignal: abortController.signal,
      },
    );
  });
});
