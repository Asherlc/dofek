// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: mockGetTracer,
  },
  SpanStatusCode: {
    ERROR: 2,
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: mockRegisterInstrumentations,
}));

vi.mock("@opentelemetry/instrumentation-fetch", () => ({
  FetchInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-xml-http-request", () => ({
  XMLHttpRequestInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-trace-web", () => ({
  WebTracerProvider: vi.fn().mockImplementation(() => ({
    register: mockProviderRegister,
  })),
}));

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

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
    expect(mockRegisterInstrumentations).not.toHaveBeenCalled();
    expect(mockStartSpan).not.toHaveBeenCalled();
    expect(addEventListenerSpy).not.toHaveBeenCalled();
  });

  it("initializes and captures exceptions when endpoint is configured", async () => {
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://collector.example/v1/traces");
    vi.stubEnv("VITE_OTEL_EXPORTER_OTLP_TRACES_HEADERS", "Authorization=Bearer test, x-key=123");

    const mod = await import("./telemetry.ts");
    mod.initTelemetry();

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://collector.example/v1/traces",
      headers: {
        Authorization: "Bearer test",
        "x-key": "123",
      },
    });
    expect(mockProviderRegister).toHaveBeenCalledTimes(1);
    expect(mockRegisterInstrumentations).toHaveBeenCalledTimes(1);
    expect(addEventListenerSpy).toHaveBeenCalledTimes(2);

    mod.captureException(new Error("kaboom"), { "custom.attr": "ok" });

    expect(mockStartSpan).toHaveBeenCalledWith(
      "ui.exception",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "exception.type": "Error",
          "exception.message": "kaboom",
          "custom.attr": "ok",
        }),
      }),
    );
    expect(mockRecordException).toHaveBeenCalled();
    expect(mockSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: "kaboom",
    });
    expect(mockEnd).toHaveBeenCalled();
  });
});
