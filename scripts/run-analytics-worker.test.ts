import { describe, expect, it, vi } from "vitest";
import { createAnalyticsWorkerFromEnvironment } from "./run-analytics-worker.ts";

function createDependencies() {
  return {
    now: () => new Date("2026-07-24T18:00:00.000Z"),
    reportFailure: vi.fn(),
    runAnalyticsBuildFromEnvironment: vi.fn().mockResolvedValue(undefined),
    runRefreshJobs: vi.fn(async (processRefresh: () => Promise<void>) => processRefresh()),
    sleep: vi.fn().mockResolvedValue(undefined),
    warmQueryCacheFromEnvironment: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createAnalyticsWorkerFromEnvironment", () => {
  it("runs the production refresh steps with configured startup and interval durations", async () => {
    const controller = new AbortController();
    const dependencies = createDependencies();
    dependencies.sleep.mockImplementation(async () => {
      return undefined;
    });
    const worker = createAnalyticsWorkerFromEnvironment(
      {
        ANALYTICS_BUILD_INTERVAL_SECONDS: "2",
        ANALYTICS_BUILD_RETRY_DELAY_SECONDS: "3",
        ANALYTICS_BUILD_STARTUP_DELAY_SECONDS: "4",
      },
      dependencies,
    );

    await worker.run(controller.signal);

    expect(dependencies.runAnalyticsBuildFromEnvironment).toHaveBeenCalledOnce();
    expect(dependencies.warmQueryCacheFromEnvironment).toHaveBeenCalledOnce();
    expect(dependencies.sleep).toHaveBeenNthCalledWith(1, 4_000, controller.signal);
    expect(dependencies.sleep).toHaveBeenCalledOnce();
    expect(dependencies.runRefreshJobs).toHaveBeenCalledWith(
      expect.any(Function),
      2_000,
      controller.signal,
    );
  });

  it("honors the configured retry duration after a failed refresh", async () => {
    const controller = new AbortController();
    const dependencies = createDependencies();
    dependencies.runAnalyticsBuildFromEnvironment.mockRejectedValue(
      new Error("provider_stats failed"),
    );
    dependencies.sleep.mockImplementation(async () => controller.abort());
    const worker = createAnalyticsWorkerFromEnvironment(
      {
        ANALYTICS_BUILD_INTERVAL_SECONDS: "2",
        ANALYTICS_BUILD_RETRY_DELAY_SECONDS: "3",
        ANALYTICS_BUILD_STARTUP_DELAY_SECONDS: "0",
      },
      dependencies,
    );

    await expect(worker.run(controller.signal)).rejects.toThrow(
      "Analytics refresh aborted before completion",
    );

    expect(dependencies.reportFailure).toHaveBeenCalledOnce();
    expect(dependencies.sleep).toHaveBeenCalledWith(3_000, controller.signal);
  });

  it("rejects durations larger than Node can schedule", () => {
    const dependencies = createDependencies();

    expect(() =>
      createAnalyticsWorkerFromEnvironment(
        { ANALYTICS_BUILD_INTERVAL_SECONDS: "2147483" },
        dependencies,
      ),
    ).not.toThrow();
    expect(() =>
      createAnalyticsWorkerFromEnvironment(
        { ANALYTICS_BUILD_INTERVAL_SECONDS: "2147484" },
        dependencies,
      ),
    ).toThrow("ANALYTICS_BUILD_INTERVAL_SECONDS must be an integer from 0 through 2147483 seconds");
  });
});

describe("runAnalyticsWorker shutdown", () => {
  it("drains active refresh work and its queue before global cleanup and Sentry", async () => {
    const calls: string[] = [];
    let releaseWork!: () => void;
    const heldWork = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const run = vi.fn(async () => {
      calls.push("worker-start");
      await heldWork;
      calls.push("worker-drained");
    });
    const refreshQueueClose = vi.fn(async () => {
      calls.push("refresh-queue-close");
    });
    const resourceCleanup = vi.fn(async () => {
      calls.push("queue-resources-close");
    });
    const sentryClose = vi.fn(async () => {
      calls.push("sentry-close");
    });
    const originalSignalListeners = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };

    vi.resetModules();
    vi.doMock("@sentry/node", () => ({ close: sentryClose }));
    vi.doMock("../src/analytics-refresh-queue.ts", () => ({
      runAnalyticsRefreshJobs: vi.fn(),
    }));
    vi.doMock("../src/jobs/queues.ts", () => ({
      closeAllQueueResources: resourceCleanup,
      createAnalyticsRefreshQueue: () => ({
        on: vi.fn(),
        close: refreshQueueClose,
      }),
      getRedisConnection: vi.fn(),
    }));
    vi.doMock("../src/analytics-worker.ts", () => ({
      AnalyticsWorker: class {
        run = run;
      },
      createAnalyticsWorkerHealthServer: () => ({
        listen: (_port: number, _host: string, callback: () => void) => callback(),
        close: (callback: () => void) => {
          calls.push("health-server-close");
          callback();
        },
      }),
    }));
    vi.doMock("../src/lib/sentry.ts", () => ({ initProductionSentry: vi.fn() }));
    vi.doMock("../src/lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
    vi.doMock("../src/logger.ts", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
    vi.doMock("./analytics-error-context.ts", () => ({
      buildAnalyticsFailureCaptureContext: vi.fn(),
    }));

    try {
      const { runAnalyticsWorker } = await import("./run-analytics-worker.ts");
      const running = runAnalyticsWorker();
      await vi.waitFor(() => expect(calls).toContain("worker-start"));
      expect(resourceCleanup).not.toHaveBeenCalled();

      releaseWork();
      await running;

      expect(calls).toEqual([
        "worker-start",
        "worker-drained",
        "refresh-queue-close",
        "health-server-close",
        "queue-resources-close",
        "sentry-close",
      ]);
    } finally {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!originalSignalListeners[signal].includes(listener)) {
            process.removeListener(signal, listener);
          }
        }
      }
      vi.doUnmock("@sentry/node");
      vi.doUnmock("../src/analytics-refresh-queue.ts");
      vi.doUnmock("../src/jobs/queues.ts");
      vi.doUnmock("../src/analytics-worker.ts");
      vi.doUnmock("../src/lib/sentry.ts");
      vi.doUnmock("../src/lib/error-reporting.ts");
      vi.doUnmock("../src/logger.ts");
      vi.doUnmock("./analytics-error-context.ts");
      vi.resetModules();
    }
  });
});
