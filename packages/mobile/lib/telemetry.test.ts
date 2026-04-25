import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  const mockCaptureMessage = vi.fn();
  const mockEmit = vi.fn();
  const mockGetLogger = vi.fn().mockReturnValue({ emit: mockEmit });
  const mockResourceFromAttributes = vi.fn().mockReturnValue({ resource: "mock" });
  const mockBatchLogRecordProcessor = vi.fn().mockReturnValue({ processor: "mock" });
  const mockLoggerProvider = vi.fn().mockImplementation(() => ({
    getLogger: mocks.mockGetLogger,
    forceFlush: mocks.mockForceFlush,
  }));
  const mockForceFlush = vi.fn().mockResolvedValue(undefined);
  return {
    mockInit,
    mockCaptureException,
    mockCaptureMessage,
    mockEmit,
    mockGetLogger,
    mockResourceFromAttributes,
    mockBatchLogRecordProcessor,
    mockLoggerProvider,
    mockForceFlush,
  };
});

vi.mock("@sentry/react-native", () => ({
  init: mocks.mockInit,
  captureException: mocks.mockCaptureException,
  captureMessage: mocks.mockCaptureMessage,
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: mocks.mockLoggerProvider,
  BatchLogRecordProcessor: mocks.mockBatchLogRecordProcessor,
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: mocks.mockResourceFromAttributes,
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

describe("ios telemetry", () => {
  let originalDsn: string | undefined;
  let originalOtelEndpoint: string | undefined;
  let originalOtelHeaders: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    originalOtelEndpoint = process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
    originalOtelHeaders = process.env.EXPO_PUBLIC_OTEL_HEADERS;
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    } else {
      process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
    }
    if (originalOtelEndpoint === undefined) {
      delete process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
    } else {
      process.env.EXPO_PUBLIC_OTEL_ENDPOINT = originalOtelEndpoint;
    }
    if (originalOtelHeaders === undefined) {
      delete process.env.EXPO_PUBLIC_OTEL_HEADERS;
    } else {
      process.env.EXPO_PUBLIC_OTEL_HEADERS = originalOtelHeaders;
    }
  });

  it("throws immediately when EXPO_PUBLIC_SENTRY_DSN is not set", async () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;

    const mod = await import("./telemetry");

    expect(() => mod.initTelemetry()).toThrow(
      "EXPO_PUBLIC_SENTRY_DSN is not set — Sentry cannot initialize",
    );
    expect(mocks.mockInit).not.toHaveBeenCalled();
  });

  it("initializes Sentry once with DSN and sends a verification message", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.initTelemetry(); // idempotent

    expect(mocks.mockInit).toHaveBeenCalledTimes(1);
    expect(mocks.mockInit).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/789",
      debug: true,
    });
    expect(mocks.mockCaptureMessage).toHaveBeenCalledWith("Sentry initialized on iOS", "info");
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

  it("captureException emits an OTel ERROR record when OTel is configured", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const error = new Error("native apple failed");
    mod.captureException(error, { source: "login-screen-handle-login" });

    expect(mocks.mockGetLogger).toHaveBeenCalledWith("exception");
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityText: "ERROR",
        body: "[exception] native apple failed",
        attributes: {
          source: "login-screen-handle-login",
          errorName: "Error",
        },
      }),
    );
  });

  it("initializes OTel LoggerProvider when endpoint is set", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    process.env.EXPO_PUBLIC_OTEL_HEADERS = "Authorization=Bearer tok123,x-axiom-dataset=dofek-logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockResourceFromAttributes).toHaveBeenCalledWith({
      "service.name": "dofek-mobile",
    });
    expect(mocks.mockBatchLogRecordProcessor).toHaveBeenCalledTimes(1);
    expect(mocks.mockLoggerProvider).toHaveBeenCalledWith({
      resource: { resource: "mock" },
      processors: [{ processor: "mock" }],
    });
  });

  it("logger.info emits OTel log record when provider is initialized", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    mod.logger.info("test-category", "hello world", { key: "value" });

    expect(mocks.mockGetLogger).toHaveBeenCalledWith("test-category");
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "[test-category] hello world",
        severityText: "INFO",
        attributes: { key: "value" },
      }),
    );
  });

  it("logger works without OTel endpoint (console-only)", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    delete process.env.EXPO_PUBLIC_OTEL_ENDPOINT;

    const mod = await import("./telemetry");
    mod.initTelemetry();

    // Should not throw
    mod.logger.info("test", "message");
    mod.logger.warn("test", "warning");
    mod.logger.error("test", "error");

    // No OTel calls
    expect(mocks.mockGetLogger).not.toHaveBeenCalled();
  });

  it("flushTelemetry flushes the OTel provider", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    await mod.flushTelemetry();

    expect(mocks.mockForceFlush).toHaveBeenCalledTimes(1);
  });
});
