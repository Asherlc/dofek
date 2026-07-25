import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsWorker, createAnalyticsWorkerHealthServer } from "./analytics-worker.ts";

const openServers: Server[] = [];
type WorkerOptions = ConstructorParameters<typeof AnalyticsWorker>[0];

function createWorkerOptions(overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    intervalMilliseconds: 900_000,
    retryDelayMilliseconds: 300_000,
    startupDelayMilliseconds: 0,
    now: () => new Date("2026-07-24T18:00:00.000Z"),
    reportFailure: vi.fn(),
    runAnalyticsBuild: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    warmQueryCache: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function startHealthServer(worker: AnalyticsWorker): Promise<string> {
  const server = createAnalyticsWorkerHealthServer(worker);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Analytics worker health server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("AnalyticsWorker", () => {
  it("reports the original dbt model failure and becomes unhealthy", async () => {
    const failure = new Error(
      "dbt build failed with exit code 1: activity_power_curve: TIMEOUT_EXCEEDED",
    );
    const reportFailure = vi.fn();
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        now: () => new Date("2026-07-24T18:48:53.000Z"),
        reportFailure,
        runAnalyticsBuild: vi.fn().mockRejectedValue(failure),
      }),
    );
    const serverUrl = await startHealthServer(worker);

    await expect(worker.runCycle()).resolves.toBe(false);
    const response = await fetch(`${serverUrl}/readyz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      currentStep: null,
      lastFailure: {
        at: "2026-07-24T18:48:53.000Z",
        message: failure.message,
        step: "analytics-build",
      },
      lastSuccessAt: null,
      status: "unhealthy",
    });
    expect(reportFailure).toHaveBeenCalledWith(failure, {
      analyticsRefreshStep: "analytics-build",
    });
  });

  it("reports a query-cache failure with its distinct refresh step", async () => {
    const failure = new Error("cycling.performance: ClickHouse timeout");
    const reportFailure = vi.fn();
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        now: () => new Date("2026-07-24T18:48:53.000Z"),
        reportFailure,
        warmQueryCache: vi.fn().mockRejectedValue(failure),
      }),
    );

    await expect(worker.runCycle()).resolves.toBe(false);

    expect(worker.getHealth()).toMatchObject({
      body: {
        lastFailure: {
          message: failure.message,
          step: "query-cache-warm",
        },
        status: "unhealthy",
      },
      statusCode: 503,
    });
    expect(reportFailure).toHaveBeenCalledWith(failure, {
      analyticsRefreshStep: "query-cache-warm",
    });
  });

  it("exposes the currently running refresh step", async () => {
    let now = new Date("2026-07-24T18:00:00.000Z");
    let finishBuild = () => {};
    const buildPending = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        now: () => now,
        runAnalyticsBuild: vi.fn(() => buildPending),
      }),
    );

    const cycle = worker.runCycle();

    expect(worker.getHealth().body).toMatchObject({
      currentStep: "analytics-build",
      status: "starting",
    });
    now = new Date("2026-07-24T18:20:00.001Z");
    expect(worker.getHealth()).toMatchObject({
      body: {
        currentStep: "analytics-build",
        status: "unhealthy",
      },
      statusCode: 503,
    });
    finishBuild();
    await cycle;
  });

  it("restores health and updates last-success time after a later successful cycle", async () => {
    let now = new Date("2026-07-24T18:48:53.000Z");
    const runAnalyticsBuild = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider_stats: TIMEOUT_EXCEEDED"))
      .mockResolvedValue(undefined);
    const warmQueryCache = vi.fn().mockResolvedValue(undefined);
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        now: () => now,
        runAnalyticsBuild,
        warmQueryCache,
      }),
    );
    const serverUrl = await startHealthServer(worker);

    await expect(worker.runCycle()).resolves.toBe(false);
    now = new Date("2026-07-24T18:54:00.000Z");
    await expect(worker.runCycle()).resolves.toBe(true);
    const response = await fetch(`${serverUrl}/readyz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      currentStep: null,
      lastFailure: {
        at: "2026-07-24T18:48:53.000Z",
        message: "provider_stats: TIMEOUT_EXCEEDED",
        step: "analytics-build",
      },
      lastSuccessAt: "2026-07-24T18:54:00.000Z",
      status: "ok",
    });
    expect(warmQueryCache).toHaveBeenCalledOnce();
  });

  it("fails health when last success exceeds the cadence and retry budget", async () => {
    let now = new Date("2026-07-24T18:00:00.000Z");
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        now: () => now,
      }),
    );
    const serverUrl = await startHealthServer(worker);

    await expect(worker.runCycle()).resolves.toBe(true);
    now = new Date("2026-07-24T18:20:00.001Z");
    const response = await fetch(`${serverUrl}/readyz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      lastSuccessAt: "2026-07-24T18:00:00.000Z",
      status: "unhealthy",
    });
  });

  it("reports a recent failed cycle as degraded until success becomes stale", async () => {
    let now = new Date("2026-07-24T18:00:00.000Z");
    const runAnalyticsBuild = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("daily_strain: database error"));
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        now: () => now,
        runAnalyticsBuild,
      }),
    );

    await expect(worker.runCycle()).resolves.toBe(true);
    now = new Date("2026-07-24T18:15:00.000Z");
    await expect(worker.runCycle()).resolves.toBe(false);

    expect(worker.getHealth()).toMatchObject({
      body: { status: "degraded" },
      statusCode: 200,
    });
  });

  it("uses the retry delay after failure and the normal cadence after recovery", async () => {
    const controller = new AbortController();
    const runAnalyticsBuild = vi
      .fn()
      .mockRejectedValueOnce(new Error("daily_strain: database error"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === 2) {
        controller.abort();
      }
    });
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        runAnalyticsBuild,
        sleep,
      }),
    );

    await worker.run(controller.signal);

    expect(runAnalyticsBuild).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 300_000, controller.signal);
    expect(sleep).toHaveBeenNthCalledWith(2, 900_000, controller.signal);
  });
});

describe("createAnalyticsWorkerHealthServer", () => {
  it("reports starting before the first refresh cycle and rejects other routes", async () => {
    const worker = new AnalyticsWorker(createWorkerOptions({ startupDelayMilliseconds: 120_000 }));
    const serverUrl = await startHealthServer(worker);

    const readinessResponse = await fetch(`${serverUrl}/readyz`);
    const missingResponse = await fetch(`${serverUrl}/healthz`);

    expect(readinessResponse.status).toBe(200);
    await expect(readinessResponse.json()).resolves.toMatchObject({
      currentStep: null,
      lastFailure: null,
      lastSuccessAt: null,
      status: "starting",
    });
    expect(missingResponse.status).toBe(404);
  });

  it("becomes unhealthy when no first success arrives within the startup budget", () => {
    let now = new Date("2026-07-24T18:00:00.000Z");
    const worker = new AnalyticsWorker(
      createWorkerOptions({
        startupDelayMilliseconds: 120_000,
        now: () => now,
      }),
    );

    now = new Date("2026-07-24T18:22:00.001Z");

    expect(worker.getHealth()).toMatchObject({
      body: { status: "unhealthy" },
      statusCode: 503,
    });
  });
});
