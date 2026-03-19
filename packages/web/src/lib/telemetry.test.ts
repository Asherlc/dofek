// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockRecordException = vi.fn();
  const mockSetStatus = vi.fn();
  const mockEnd = vi.fn();
  const mockStartSpan = vi.fn(() => ({
    recordException: mockRecordException,
    setStatus: mockSetStatus,
    end: mockEnd,
  }));
  const mockGetTracer = vi.fn(() => ({ startSpan: mockStartSpan }));
  const mockRegisterInstrumentations = vi.fn();
  const mockProviderRegister = vi.fn();
  const mockTraceExporterCtor = vi.fn((config?: unknown) => ({ kind: "exporter", config }));
  const mockBatchSpanProcessorCtor = vi.fn((exporter?: unknown) => ({
    kind: "batch-span-processor",
    exporter,
  }));
  const mockFetchInstrumentationCtor = vi.fn((config?: unknown) => ({ kind: "fetch", config }));
  const mockXhrInstrumentationCtor = vi.fn((config?: unknown) => ({ kind: "xhr", config }));
  const mockWebTracerProviderCtor = vi.fn((config?: unknown) => ({
    kind: "provider",
    config,
    register: mockProviderRegister,
  }));

  return {
    mockRecordException,
    mockSetStatus,
    mockEnd,
    mockStartSpan,
    mockGetTracer,
    mockRegisterInstrumentations,
    mockProviderRegister,
    mockTraceExporterCtor,
    mockBatchSpanProcessorCtor,
    mockFetchInstrumentationCtor,
    mockXhrInstrumentationCtor,
    mockWebTracerProviderCtor,
  };
});

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: mocks.mockGetTracer,
  },
  SpanStatusCode: {
    ERROR: 2,
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: mocks.mockTraceExporterCtor,
}));

vi.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: mocks.mockRegisterInstrumentations,
}));

vi.mock("@opentelemetry/instrumentation-fetch", () => ({
  FetchInstrumentation: mocks.mockFetchInstrumentationCtor,
}));

vi.mock("@opentelemetry/instrumentation-xml-http-request", () => ({
  XMLHttpRequestInstrumentation: mocks.mockXhrInstrumentationCtor,
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: mocks.mockBatchSpanProcessorCtor,
}));

vi.mock("@opentelemetry/sdk-trace-web", () => ({
  WebTracerProvider: mocks.mockWebTracerProviderCtor,
}));

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

function getEventListener(name: string, spy: ReturnType<typeof vi.spyOn>) {
  const call = spy.mock.calls.find((candidate) => candidate[0] === name);
  if (!call) {
    return undefined;
  }
  const listener = call[1];
  if (typeof listener !== "function") {
    return undefined;
  }
  return (event: Event) => listener(event);
}

function getPropagationTargets(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const targets = Reflect.get(value, "propagateTraceHeaderCorsUrls");
  if (!Array.isArray(targets)) {
    return undefined;
  }
  if (!targets.every((target) => target instanceof RegExp)) {
    return undefined;
  }
  return targets;
}

describe("web telemetry", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    addEventListenerSpy = vi.spyOn(window, "addEventListener").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    addEventListenerSpy?.mockRestore();
  });

  it("does not initialize without an endpoint", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "");
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_ENDPOINT", "");

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();
    mod.captureException(new Error("boom"));

    expect(OTLPTraceExporter).not.toHaveBeenCalled();
    expect(mocks.mockRegisterInstrumentations).not.toHaveBeenCalled();
    expect(mocks.mockStartSpan).not.toHaveBeenCalled();
    expect(addEventListenerSpy).not.toHaveBeenCalled();
  });

  it("initializes once and configures providers and instrumentations", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example/v1/traces");
    vi.stubEnv(
      "VITE_OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "Authorization=Bearer test,invalid,x-key=123",
    );

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();
    mod.initTelemetry();

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://collector.example/v1/traces",
      headers: {
        Authorization: "Bearer test",
        "x-key": "123",
      },
    });

    const exporterInstance = mocks.mockTraceExporterCtor.mock.results[0]?.value;
    expect(mocks.mockBatchSpanProcessorCtor).toHaveBeenCalledWith(exporterInstance);
    const batchSpanProcessorInstance = mocks.mockBatchSpanProcessorCtor.mock.results[0]?.value;
    expect(mocks.mockWebTracerProviderCtor).toHaveBeenCalledWith({
      spanProcessors: [batchSpanProcessorInstance],
    });

    const providerInstance = mocks.mockWebTracerProviderCtor.mock.results[0]?.value;
    expect(mocks.mockProviderRegister).toHaveBeenCalledTimes(1);
    const fetchInstrumentationInstance = mocks.mockFetchInstrumentationCtor.mock.results[0]?.value;
    const xhrInstrumentationInstance = mocks.mockXhrInstrumentationCtor.mock.results[0]?.value;
    expect(mocks.mockRegisterInstrumentations).toHaveBeenCalledWith({
      tracerProvider: providerInstance,
      instrumentations: [fetchInstrumentationInstance, xhrInstrumentationInstance],
    });

    expect(mocks.mockTraceExporterCtor).toHaveBeenCalledTimes(1);
    expect(mocks.mockBatchSpanProcessorCtor).toHaveBeenCalledTimes(1);
    expect(mocks.mockFetchInstrumentationCtor).toHaveBeenCalledTimes(1);
    expect(mocks.mockXhrInstrumentationCtor).toHaveBeenCalledTimes(1);

    const fetchOptions = mocks.mockFetchInstrumentationCtor.mock.calls[0]?.[0];
    const targets = getPropagationTargets(fetchOptions);
    expect(targets).toHaveLength(3);
    expect(targets?.[0]?.test("/api/ping")).toBe(true);
    expect(targets?.[0]?.test("x/api/ping")).toBe(false);
    expect(targets?.[1]?.test("/auth/login")).toBe(true);
    expect(targets?.[1]?.test("x/auth/login")).toBe(false);
    expect(targets?.[2]?.test("/callback")).toBe(true);
    expect(targets?.[2]?.test("/x/callback")).toBe(false);

    expect(addEventListenerSpy).toHaveBeenCalledTimes(2);
    expect(addEventListenerSpy).toHaveBeenNthCalledWith(1, "error", expect.any(Function));
    expect(addEventListenerSpy).toHaveBeenNthCalledWith(
      2,
      "unhandledrejection",
      expect.any(Function),
    );
  });

  it("passes undefined headers when header env is empty", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example/v1/traces");
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_HEADERS", "");

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://collector.example/v1/traces",
      headers: undefined,
    });
  });

  it("captures browser error and unhandled rejection events", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example/v1/traces");
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_HEADERS", "invalid");

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();

    const onError = getEventListener("error", addEventListenerSpy);
    const onUnhandledRejection = getEventListener("unhandledrejection", addEventListenerSpy);
    expect(onError).toBeDefined();
    expect(onUnhandledRejection).toBeDefined();

    const browserErrorEvent = new Event("error");
    Object.defineProperties(browserErrorEvent, {
      error: { value: undefined },
      message: { value: "window boom" },
      filename: { value: "src/app.tsx" },
      lineno: { value: 5 },
      colno: { value: 11 },
    });
    onError?.(browserErrorEvent);

    const rejectionEvent = new Event("unhandledrejection");
    Object.defineProperty(rejectionEvent, "reason", { value: "promise boom" });
    onUnhandledRejection?.(rejectionEvent);

    expect(mocks.mockStartSpan).toHaveBeenCalledWith(
      "ui.exception",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "exception.type": "Error",
          "exception.message": "window boom",
          "error.source": "window.onerror",
          "error.filename": "src/app.tsx",
          "error.lineno": 5,
          "error.colno": 11,
        }),
      }),
    );
    expect(mocks.mockStartSpan).toHaveBeenCalledWith(
      "ui.exception",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "exception.type": "Error",
          "exception.message": "promise boom",
          "error.source": "window.unhandledrejection",
        }),
      }),
    );
    expect(mocks.mockGetTracer).toHaveBeenCalledWith("dofek-web");
    expect(mocks.mockRecordException).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "window boom" }),
    );
    expect(mocks.mockRecordException).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "promise boom" }),
    );
    expect(mocks.mockSetStatus).toHaveBeenNthCalledWith(1, {
      code: 2,
      message: "window boom",
    });
    expect(mocks.mockSetStatus).toHaveBeenNthCalledWith(2, {
      code: 2,
      message: "promise boom",
    });
    expect(mocks.mockEnd).toHaveBeenCalledTimes(2);
  });
});
