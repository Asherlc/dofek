import type express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInitTelemetry = vi.fn();
  const mockCaptureException = vi.fn();
  return { mockInitTelemetry, mockCaptureException };
});

vi.mock("dofek/telemetry", () => ({
  initTelemetry: mocks.mockInitTelemetry,
  captureException: mocks.mockCaptureException,
}));

/** Type-safe partial mock helper — avoids banned `as` assertions. */
function mockOf<T extends object>(partial: Partial<T>): T {
  const result: T = partial;
  return result;
}

describe("server telemetry", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    const { __resetTelemetryErrorReportingInitialized } = await import(
      "./telemetry-error-handler.ts"
    );
    __resetTelemetryErrorReportingInitialized();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("initializes telemetry once", async () => {
    const { initTelemetryErrorReporting } = await import("./telemetry-error-handler.ts");
    initTelemetryErrorReporting();
    initTelemetryErrorReporting(); // idempotent

    expect(mocks.mockInitTelemetry).toHaveBeenCalledTimes(1);
  });

  it("error handler captures exception and returns 500", async () => {
    const { telemetryErrorHandler } = await import("./telemetry-error-handler.ts");
    const handler = telemetryErrorHandler();

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
    const { telemetryErrorHandler } = await import("./telemetry-error-handler.ts");
    const handler = telemetryErrorHandler();

    const error = new Error("boom");
    const mockRes = mockOf<express.Response>({ headersSent: true });
    const mockReq = mockOf<express.Request>({});
    const mockNext = vi.fn();

    handler(error, mockReq, mockRes, mockNext);

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockNext).toHaveBeenCalledWith(error);
  });
});
