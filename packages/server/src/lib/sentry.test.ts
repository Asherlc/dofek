import type express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  return { mockInit, mockCaptureException };
});

vi.mock("@sentry/node", () => ({
  init: mocks.mockInit,
  captureException: mocks.mockCaptureException,
}));

/** Type-safe partial mock helper — avoids banned `as` assertions. */
function mockOf<T extends object>(partial: Partial<T>): T {
  const result: T = partial;
  return result;
}

describe("server sentry", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    const { __resetSentryInitialized } = await import("./sentry.ts");
    __resetSentryInitialized();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not initialize without SENTRY_DSN", async () => {
    delete process.env.SENTRY_DSN;

    const { initSentry } = await import("./sentry.ts");
    initSentry();

    expect(mocks.mockInit).not.toHaveBeenCalled();
  });

  it("initializes Sentry once with skipOpenTelemetrySetup", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/456");

    const { initSentry } = await import("./sentry.ts");
    initSentry();
    initSentry(); // idempotent

    expect(mocks.mockInit).toHaveBeenCalledTimes(1);
    expect(mocks.mockInit).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/456",
      skipOpenTelemetrySetup: true,
    });
  });

  it("error handler captures exception and returns 500", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/456");

    const { sentryErrorHandler } = await import("./sentry.ts");
    const handler = sentryErrorHandler();

    const error = new Error("boom");
    const mockRes = mockOf<express.Response>({
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    });
    const mockReq = mockOf<express.Request>({});
    const mockNext = vi.fn();

    handler(error, mockReq, mockRes, mockNext);

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("error handler calls next when headers already sent", async () => {
    const { sentryErrorHandler } = await import("./sentry.ts");
    const handler = sentryErrorHandler();

    const error = new Error("boom");
    const mockRes = mockOf<express.Response>({ headersSent: true });
    const mockReq = mockOf<express.Request>({});
    const mockNext = vi.fn();

    handler(error, mockReq, mockRes, mockNext);

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockNext).toHaveBeenCalledWith(error);
  });
});
