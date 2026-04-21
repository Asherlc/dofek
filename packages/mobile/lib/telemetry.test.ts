import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockEmit = vi.fn();
  const mockGetLogger = vi.fn().mockReturnValue({ emit: mockEmit });
  const mockAddLogRecordProcessor = vi.fn();
  const mockForceFlush = vi.fn().mockResolvedValue(undefined);
  return {
    mockEmit,
    mockGetLogger,
    mockAddLogRecordProcessor,
    mockForceFlush,
  };
});

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
  let originalOtelEndpoint: string | undefined;
  let originalOtelHeaders: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    originalOtelEndpoint = process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
    originalOtelHeaders = process.env.EXPO_PUBLIC_OTEL_HEADERS;
  });

  afterEach(() => {
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

  it("initializes without OTLP endpoint (console-only)", async () => {
    delete process.env.EXPO_PUBLIC_OTEL_ENDPOINT;

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockAddLogRecordProcessor).not.toHaveBeenCalled();
  });

  it("initializes LoggerProvider when endpoint is set", async () => {
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";
    process.env.EXPO_PUBLIC_OTEL_HEADERS = "Authorization=Bearer tok123,x-axiom-dataset=dofek-logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockAddLogRecordProcessor).toHaveBeenCalledTimes(1);
  });

  it("captureException emits an exception log record", async () => {
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.captureException(new Error("test error"), { source: "react-native.global" });

    expect(mocks.mockGetLogger).toHaveBeenCalledWith("exception");
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "[exception] test error",
        severityText: "ERROR",
      }),
    );
  });

  it("addBreadcrumb emits a telemetry message", async () => {
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.addBreadcrumb("whoop-ble", "Connected", "info", { deviceId: "strap-1" });

    expect(mocks.mockGetLogger).toHaveBeenCalledWith("telemetry");
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "[telemetry] [whoop-ble] Connected",
      }),
    );
  });

  it("flushTelemetry flushes the OTel provider", async () => {
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    await mod.flushTelemetry();

    expect(mocks.mockForceFlush).toHaveBeenCalledTimes(1);
  });
});
