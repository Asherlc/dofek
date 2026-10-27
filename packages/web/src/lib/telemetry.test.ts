// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  const mockBrowserTracingIntegration = vi.fn(() => ({ name: "BrowserTracing" }));
  const mockPostHogCaptureException = vi.fn();
  const mockPostHogIdentify = vi.fn();
  const mockPostHogReset = vi.fn();

  return {
    mockInit,
    mockCaptureException,
    mockBrowserTracingIntegration,
    mockPostHogCaptureException,
    mockPostHogIdentify,
    mockPostHogReset,
  };
});

vi.mock("@sentry/react", () => ({
  init: mocks.mockInit,
  captureException: mocks.mockCaptureException,
  browserTracingIntegration: mocks.mockBrowserTracingIntegration,
}));

vi.mock("posthog-js", () => ({
  default: {
    captureException: mocks.mockPostHogCaptureException,
    identify: mocks.mockPostHogIdentify,
    reset: mocks.mockPostHogReset,
  },
}));

describe("web telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("__COMMIT_HASH__", "abc1234");
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
      release: "abc1234",
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
    expect(mocks.mockPostHogCaptureException).toHaveBeenCalledWith(error, {
      "react.component_stack": "<App>",
    });
  });

  it("identifies the authenticated user with durable person properties", async () => {
    const mod = await import("./telemetry.ts");

    mod.identifyUser({
      id: "user-123",
      name: "Alice Example",
      email: "alice@example.com",
    });

    expect(mocks.mockPostHogIdentify).toHaveBeenCalledWith("user-123", {
      email: "alice@example.com",
      name: "Alice Example",
    });
  });

  it("preserves a nullable email when identifying the user", async () => {
    const mod = await import("./telemetry.ts");

    mod.identifyUser({
      id: "user-456",
      name: "Private User",
      email: null,
    });

    expect(mocks.mockPostHogIdentify).toHaveBeenCalledWith("user-456", {
      email: null,
      name: "Private User",
    });
  });

  it("resets the browser identity", async () => {
    const mod = await import("./telemetry.ts");

    mod.resetUser();

    expect(mocks.mockPostHogReset).toHaveBeenCalledOnce();
  });
});
