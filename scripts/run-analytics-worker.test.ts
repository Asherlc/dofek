import { describe, expect, it, vi } from "vitest";
import { createAnalyticsWorkerFromEnvironment } from "./run-analytics-worker.ts";

function createDependencies() {
  return {
    now: () => new Date("2026-07-24T18:00:00.000Z"),
    reportFailure: vi.fn(),
    runAnalyticsBuildFromEnvironment: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    warmQueryCacheFromEnvironment: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createAnalyticsWorkerFromEnvironment", () => {
  it("runs the production refresh steps with configured startup and interval durations", async () => {
    const controller = new AbortController();
    const dependencies = createDependencies();
    dependencies.sleep.mockImplementation(async () => {
      if (dependencies.sleep.mock.calls.length === 2) {
        controller.abort();
      }
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
    expect(dependencies.sleep).toHaveBeenNthCalledWith(2, 2_000, controller.signal);
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

    await worker.run(controller.signal);

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
