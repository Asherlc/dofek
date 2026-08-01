import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockInit = vi.fn();
  const mockCaptureException = vi.fn();
  const mockCaptureMessage = vi.fn();
  const mockAddBreadcrumb = vi.fn();
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
    mockAddBreadcrumb,
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
  addBreadcrumb: mocks.mockAddBreadcrumb,
}));

const posthogMocks = vi.hoisted(() => {
  const captureException = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn();
  const mockPosthogConstructor = vi.fn((_apiKey: string, _options: PostHogClientOptions) => ({
    captureException,
    flush,
    register,
  }));
  return { captureException, flush, register, mockPosthogConstructor };
});

type PostHogClientOptions = {
  host: string;
  errorTracking: {
    autocapture: {
      uncaughtExceptions: boolean;
      unhandledRejections: boolean;
    };
  };
};

vi.mock("posthog-react-native", () => ({
  default: posthogMocks.mockPosthogConstructor,
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
    vi.stubGlobal("__DEV__", true);

    originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    originalOtelEndpoint = process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
    originalOtelHeaders = process.env.EXPO_PUBLIC_OTEL_HEADERS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("initializes Sentry once with DSN", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.initTelemetry(); // idempotent

    expect(mocks.mockInit).toHaveBeenCalledTimes(1);
    expect(mocks.mockInit).toHaveBeenCalledWith({
      dsn: "https://key@sentry.example/789",
      debug: true,
      tracesSampler: expect.any(Function),
    });
    const options = mocks.mockInit.mock.calls[0]?.[0];
    const tracesSampler = options?.tracesSampler;
    expect(tracesSampler?.({ name: "App Start", inheritOrSampleWith: vi.fn() })).toBe(1);
    expect(tracesSampler?.({ name: "Mobile Startup", inheritOrSampleWith: vi.fn() })).toBe(1);
    expect(
      tracesSampler?.({
        name: "unrelated navigation",
        inheritOrSampleWith: vi.fn().mockReturnValue(0),
      }),
    ).toBe(0);
    expect(mocks.mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("initializes PostHog with crash-only error autocapture in production builds", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    vi.stubGlobal("__DEV__", false);

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(mocks.mockInit).toHaveBeenCalledWith(expect.objectContaining({ debug: false }));
    expect(posthogMocks.mockPosthogConstructor).toHaveBeenCalledTimes(1);
    const options = posthogMocks.mockPosthogConstructor.mock.calls[0]?.[1];
    expect(options).toMatchObject({ host: "https://us.i.posthog.com" });
    expect(options?.errorTracking.autocapture).toEqual({
      uncaughtExceptions: true,
      unhandledRejections: true,
    });
    expect(posthogMocks.register).toHaveBeenCalledWith({
      service: "dofek-mobile",
    });
  });

  it("delegates captureException to Sentry with a searchable source tag and extra context", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const error = new Error("test error");
    mod.captureException(error, {
      source: "react-native-global",
      operation: "global-handler",
    });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: "react-native-global" },
      extra: {
        source: "react-native-global",
        operation: "global-handler",
      },
    });
  });

  it("adds the sanitized current route to error context", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/activity/550e8400-e29b-41d4-a716-446655440000");

    mod.captureException(new Error("request failed"), { source: "react-query" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          source: "react-query",
          route: "/activity/:id",
        },
      }),
    );
  });

  it("redacts UUID routes from versions 6 through 8", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/activity/550e8400-e29b-61d4-a716-446655440000");

    mod.captureException(new Error("request failed"), { source: "react-query" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          source: "react-query",
          route: "/activity/:id",
        },
      }),
    );
  });

  it("keeps an explicitly supplied route over the global route", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/settings");

    mod.captureException(new Error("request failed"), {
      source: "react-query",
      route: "/providers",
    });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          source: "react-query",
          route: "/providers",
        },
      }),
    );
  });

  it("does not retain a malformed explicit route or fall back to the global route", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.setTelemetryRoute("/settings");

    mod.captureException(new Error("request failed"), {
      source: "react-query",
      route: "?token=secret",
    });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: {
          source: "react-query",
          route: undefined,
        },
      }),
    );
    expect(JSON.stringify(mocks.mockCaptureException.mock.calls)).not.toContain("secret");
  });

  it("drops transient background HealthKit network errors from Sentry and PostHog", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";
    process.env.EXPO_PUBLIC_OTEL_ENDPOINT = "https://api.axiom.co/v1/logs";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const connectionLostError = new Error(
      "fetch failed: UnexpectedException: The network connection was lost.",
    );
    mod.captureException(connectionLostError, { source: "bg-healthkit-sync" });

    // Neither error-tracking destination receives the suppressed error...
    expect(mocks.mockCaptureException).not.toHaveBeenCalled();
    expect(posthogMocks.captureException).not.toHaveBeenCalled();
    // ...but the failure is still logged for observability.
    expect(mocks.mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityText: "ERROR",
        body: "[exception] fetch failed: UnexpectedException: The network connection was lost.",
      }),
    );
  });

  it("still reports transient network errors from non-HealthKit sources", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    const connectionLostError = new Error(
      "fetch failed: UnexpectedException: The network connection was lost.",
    );
    mod.captureException(connectionLostError, { source: "react-query" });

    expect(mocks.mockCaptureException).toHaveBeenCalledWith(connectionLostError, {
      tags: { source: "react-query" },
      extra: { source: "react-query" },
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
    expect(mocks.mockBatchLogRecordProcessor).toHaveBeenCalledWith({
      exporter: expect.any(OTLPLogExporter),
    });
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

  it("logger.info adds a Sentry breadcrumb with sanitized data", async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://key@sentry.example/789";

    const mod = await import("./telemetry");
    mod.initTelemetry();

    mod.logger.info("screen-navigation", "Nutrition tab selected", {
      route: "food",
      selected: true,
      count: 1,
      ignored: { nested: "value" },
    });

    expect(mocks.mockAddBreadcrumb).toHaveBeenCalledWith({
      category: "screen-navigation",
      message: "Nutrition tab selected",
      level: "info",
      data: {
        route: "food",
        selected: true,
        count: 1,
      },
    });
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
