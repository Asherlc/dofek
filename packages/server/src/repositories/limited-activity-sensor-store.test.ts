import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";
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
});
