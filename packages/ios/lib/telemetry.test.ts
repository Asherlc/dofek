import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRecordException = vi.fn();
const mockSetStatus = vi.fn();
const mockSetAttribute = vi.fn();
const mockEnd = vi.fn();
const mockStartSpan = vi.fn(() => ({
  recordException: mockRecordException,
  setStatus: mockSetStatus,
  setAttribute: mockSetAttribute,
  end: mockEnd,
}));
const mockGetTracer = vi.fn(() => ({ startSpan: mockStartSpan }));
const mockSetGlobalTracerProvider = vi.fn();
const mockSetSpan = vi.fn((ctx) => ctx);
const mockContextActive = vi.fn(() => ({}));
const mockContextWith = vi.fn((_ctx, callback: () => Promise<unknown>) => callback());
const mockInject = vi.fn((_ctx, carrier: Record<string, string>) => {
  carrier.traceparent = "00-test-trace-header";
});
const mockSetGlobalPropagator = vi.fn();

vi.mock("@opentelemetry/api", () => ({
  context: {
    active: mockContextActive,
    with: mockContextWith,
  },
  propagation: {
    inject: mockInject,
    setGlobalPropagator: mockSetGlobalPropagator,
  },
  SpanStatusCode: {
    ERROR: 2,
  },
  trace: {
    getTracer: mockGetTracer,
    setGlobalTracerProvider: mockSetGlobalTracerProvider,
    setSpan: mockSetSpan,
  },
}));

vi.mock("@opentelemetry/core", () => ({
  CompositePropagator: vi.fn().mockImplementation((config) => config),
  W3CBaggagePropagator: vi.fn(),
  W3CTraceContextPropagator: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: vi.fn(),
  BasicTracerProvider: vi.fn(),
}));

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

describe("ios telemetry", () => {
  let originalEndpoint: string | undefined;
  let originalHeaders: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let originalErrorUtils: unknown;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    originalEndpoint = process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    originalHeaders = process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    originalFetch = globalThis.fetch;
    originalErrorUtils = (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
    delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    } else {
      process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalEndpoint;
    }

    if (originalHeaders === undefined) {
      delete process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    } else {
      process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_HEADERS = originalHeaders;
    }

    globalThis.fetch = originalFetch;
    if (originalErrorUtils === undefined) {
      delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
    } else {
      (globalThis as { ErrorUtils?: unknown }).ErrorUtils = originalErrorUtils;
    }
  });

  it("does not initialize without an endpoint", async () => {
    delete process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const mod = await import("./telemetry");
    mod.initTelemetry();
    mod.captureException(new Error("boom"));

    expect(OTLPTraceExporter).not.toHaveBeenCalled();
    expect(BasicTracerProvider).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(fetchMock);
    expect(mockStartSpan).not.toHaveBeenCalled();
  });

  it("preserves Request headers/method and injects trace headers", async () => {
    process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "https://collector.example/v1/traces";
    process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_HEADERS = "Authorization=Bearer abc";

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const mod = await import("./telemetry");
    mod.initTelemetry();

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://collector.example/v1/traces",
      headers: {
        Authorization: "Bearer abc",
      },
    });
    expect(BasicTracerProvider).toHaveBeenCalledTimes(1);

    const request = new Request("https://example.com/private", {
      method: "POST",
      headers: {
        Authorization: "Bearer token-from-request",
      },
    });
    await globalThis.fetch(request);

    const forwardedCall = fetchMock.mock.calls[0];
    expect(forwardedCall).toBeDefined();
    const forwardedInit = forwardedCall?.[1];
    const forwardedHeaders = new Headers(forwardedInit?.headers);
    expect(forwardedHeaders.get("Authorization")).toBe("Bearer token-from-request");
    expect(forwardedHeaders.get("traceparent")).toBe("00-test-trace-header");

    expect(mockStartSpan).toHaveBeenCalledWith(
      "http.client",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "http.request.method": "POST",
          "url.full": "https://example.com/private",
        }),
      }),
    );
    expect(mockSetGlobalTracerProvider).toHaveBeenCalledTimes(1);
    expect(mockSetGlobalPropagator).toHaveBeenCalledTimes(1);

    mod.captureException(new Error("kaboom"));
    const spanNames = mockStartSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("mobile.exception");
    expect(mockRecordException).toHaveBeenCalled();
    expect(mockEnd).toHaveBeenCalled();
  });
});
