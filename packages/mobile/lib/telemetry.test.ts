import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  const mockEmit = vi.fn();
  const mockGetLogger = vi.fn().mockReturnValue({ emit: mockEmit });
  const mockAddLogRecordProcessor = vi.fn();
  const mockForceFlush = vi.fn().mockResolvedValue(undefined);
  return {
    mockInit,
    mockCaptureException,
    mockEmit,
    mockGetLogger,
    mockAddLogRecordProcessor,
    mockForceFlush,
  };
});

vi.mock("@sentry/react-native", () => ({
  init: mocks.mockInit,
  captureException: mocks.mockCaptureException,
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: vi.fn().mockImplementation(() => ({
    getLogger: mocks.mockGetLogger,
    addLogRecordProcessor: mocks.mockAddLogRecordProcessor,
    forceFlush: mocks.mockForceFlush,
  })),
  BatchLogRecordProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  Resource: vi.fn(),
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
      enableNativeSdk: false,
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

  it("initializes OTel LoggerProvider when endpoint is set", async () => {
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    process.env.EXPO_PUBLIC_OTEL_HEADERS = "Authorization=Bearer tok123,x-axiom-dataset=dofek-logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockAddLogRecordProcessor).toHaveBeenCalledTimes(1);
  });

  it("logger.info emits OTel log record when provider is initialized", async () => {
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
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    await mod.flushTelemetry();

    expect(mocks.mockForceFlush).toHaveBeenCalledTimes(1);
  });
});
