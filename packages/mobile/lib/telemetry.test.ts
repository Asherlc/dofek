import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  return { mockInit, mockCaptureException };
});

vi.mock("@sentry/react-native", () => ({
  init: mocks.mockInit,
  captureException: mocks.mockCaptureException,
}));

describe("ios telemetry", () => {
  let originalDsn: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    } else {
      process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
    }
  });

  it("does not initialize without a DSN", async () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.captureException(new Error("boom"));

    expect(mocks.mockInit).not.toHaveBeenCalled();
    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: {} }),
    );
  });

  it("initializes Sentry once with DSN", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.initTelemetry(); // idempotent

    expect(mocks.mockInit).toHaveBeenCalledTimes(1);
    expect(mocks.mockInit).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/789",
    });
  });

  it("delegates captureException to Sentry with extra context", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const error = new Error("test error");
    mod.captureException(error, { "error.source": "react-native.global" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error, {
      extra: { "error.source": "react-native.global" },
    });
  });
});
