import type { HealthExplorerSnapshot } from "@dofek/mcp-contracts/health-explorer";
import { captureException } from "@sentry/react";
import { describe, expect, it, vi } from "vitest";
import { createMetricRequestHandler } from "./metric-request.ts";

vi.mock("@sentry/react", () => ({ captureException: vi.fn() }));

const snapshot: HealthExplorerSnapshot = {
  range: {
    start_date: "2026-08-01",
    end_date: "2026-08-03",
    granularity: "daily",
    timezone: "America/Los_Angeles",
  },
  series: [],
  summary: [],
  coverage: { requested_days: 3, by_metric: {} },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createMetricRequestHandler", () => {
  it("ignores stale responses and reports only the latest failure", async () => {
    const first = deferred<{ structuredContent: unknown }>();
    const second = deferred<{ structuredContent: unknown }>();
    const setSnapshot = vi.fn();
    const setError = vi.fn();
    const app = {
      callServerTool: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const handler = createMetricRequestHandler({
      setError,
      setSnapshot,
    });

    const firstRequest = handler(app, snapshot, "hrv");
    const secondRequest = handler(app, snapshot, "steps");
    second.resolve({ structuredContent: { ...snapshot, range: { ...snapshot.range } } });
    await secondRequest;
    first.resolve({
      structuredContent: { ...snapshot, summary: [{ metric: "hrv", average: 1, min: 1, max: 1 }] },
    });
    await firstRequest;

    expect(app.callServerTool).toHaveBeenNthCalledWith(2, {
      name: "render_health_explorer",
      arguments: { ...snapshot.range, metrics: ["steps"] },
    });
    expect(setSnapshot).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports malformed responses and current-request failures", async () => {
    const setSnapshot = vi.fn();
    const setError = vi.fn();
    const handler = createMetricRequestHandler({ setError, setSnapshot });
    const invalidApp = { callServerTool: vi.fn().mockResolvedValue({ structuredContent: {} }) };

    await handler(invalidApp, snapshot, "hrv");
    expect(setSnapshot).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "Dofek Explorer received an invalid response from the server. Please try again.",
    );

    const failure = new Error("request failed");
    const failingApp = { callServerTool: vi.fn().mockRejectedValue(failure) };
    await handler(failingApp, snapshot, "steps");
    expect(captureException).toHaveBeenCalledWith(failure);
    expect(setError).toHaveBeenLastCalledWith("request failed");
  });
});
