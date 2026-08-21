import type express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockCaptureException = vi.fn();
  const mockInitProductionSentry = vi.fn();
  const mockInitProductionPostHog = vi.fn();
  return { mockCaptureException, mockInitProductionSentry, mockInitProductionPostHog };
});

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: mocks.mockCaptureException,
}));

vi.mock("dofek/lib/sentry", () => ({
  initProductionSentry: mocks.mockInitProductionSentry,
}));

vi.mock("dofek/lib/posthog", () => ({
  initProductionPostHog: mocks.mockInitProductionPostHog,
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

  it("delegates an absent DSN once", async () => {
    delete process.env.SENTRY_DSN;

    const { initSentry } = await import("./sentry.ts");
    initSentry();

    expect(mocks.mockInitProductionPostHog).toHaveBeenCalledWith("dofek-web-server");
    expect(mocks.mockInitProductionSentry).toHaveBeenCalledOnce();
    expect(mocks.mockInitProductionSentry).toHaveBeenCalledWith(undefined);
  });

  it("delegates Sentry initialization once", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.example/456");

    const { initSentry } = await import("./sentry.ts");
    initSentry();
    initSentry(); // idempotent

    expect(mocks.mockInitProductionPostHog).toHaveBeenCalledOnce();
    expect(mocks.mockInitProductionSentry).toHaveBeenCalledOnce();
    expect(mocks.mockInitProductionSentry).toHaveBeenCalledWith("https://key@sentry.example/456");
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
