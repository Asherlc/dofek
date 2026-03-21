// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  const mockBrowserTracingIntegration = vi.fn(() => ({ name: "BrowserTracing" }));

  return {
    mockInit,
    mockCaptureException,
    mockBrowserTracingIntegration,
  };
});

vi.mock("@sentry/react", () => ({
  init: mocks.mockInit,
  captureException: mocks.mockCaptureException,
  browserTracingIntegration: mocks.mockBrowserTracingIntegration,
}));

describe("web telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not initialize without a DSN", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();
    mod.captureException(new Error("boom"));

    expect(mocks.mockInit).not.toHaveBeenCalled();
    // captureException still delegates to Sentry (it's a no-op when uninitialised)
    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: {} }),
    );
  });

  it("initializes Sentry once with DSN and browser tracing", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@sentry.example/123");

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();
    mod.initTelemetry(); // idempotent

    expect(mocks.mockInit).toHaveBeenCalledTimes(1);
    expect(mocks.mockInit).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/123",
      integrations: [{ name: "BrowserTracing" }],
      tracePropagationTargets: [/^\/api/, /^\/auth/, /^\/callback/],
    });
  });

  it("delegates captureException to Sentry with extra context", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@sentry.example/123");

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();

    const error = new Error("test error");
    mod.captureException(error, { "react.component_stack": "<App>" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error, {
      extra: { "react.component_stack": "<App>" },
    });
  });
});
