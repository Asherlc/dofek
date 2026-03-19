import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { WinstonInstrumentation } from "@opentelemetry/instrumentation-winston";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStart = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn().mockImplementation(() => ({
    start: mockStart,
    shutdown: mockShutdown,
  })),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  BatchSpanProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-winston", () => ({
  WinstonInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-express", () => ({
  ExpressInstrumentation: vi.fn(),
}));

function removeExtraListeners(signal: NodeJS.Signals, countBefore: number): void {
  while (process.listenerCount(signal) > countBefore) {
    const listeners = process.listeners(signal);
    const last = listeners[listeners.length - 1];
    if (last) {
      process.removeListener(signal, last);
    } else {
      break;
    }
  }
}

describe("instrumentation", () => {
  let originalEndpoint: string | undefined;
  let originalTracesEndpoint: string | undefined;
  let originalLogsEndpoint: string | undefined;
  let sigTermCountBefore: number;
  let sigIntCountBefore: number;

  beforeEach(() => {
    originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    originalTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    originalLogsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    sigTermCountBefore = process.listenerCount("SIGTERM");
    sigIntCountBefore = process.listenerCount("SIGINT");
    vi.mocked(NodeSDK).mockClear();
    vi.mocked(OTLPTraceExporter).mockClear();
    vi.mocked(OTLPLogExporter).mockClear();
    vi.mocked(BatchSpanProcessor).mockClear();
    vi.mocked(BatchLogRecordProcessor).mockClear();
    vi.mocked(WinstonInstrumentation).mockClear();
    vi.mocked(HttpInstrumentation).mockClear();
    vi.mocked(ExpressInstrumentation).mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    if (originalTracesEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalTracesEndpoint;
    }
    if (originalLogsEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = originalLogsEndpoint;
    }
    removeExtraListeners("SIGTERM", sigTermCountBefore);
    removeExtraListeners("SIGINT", sigIntCountBefore);
  });

  it("exports startInstrumentation function", async () => {
    const mod = await import("./instrumentation.ts");
    expect(typeof mod.startInstrumentation).toBe("function");
  });

  it("returns undefined when no OTLP endpoints are set", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    const { startInstrumentation } = await import("./instrumentation.ts");

    const sdk = startInstrumentation({});

    expect(sdk).toBeUndefined();
  });

  it("returns an SDK instance when OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    const sdk = startInstrumentation({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    });

    expect(sdk).toBeDefined();
    expect(mockStart).toHaveBeenCalled();
    await sdk?.shutdown();
  });

  it("picks up OTEL_EXPORTER_OTLP_ENDPOINT_unencrypted (SOPS convention)", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    const sdk = startInstrumentation({
      OTEL_EXPORTER_OTLP_ENDPOINT_unencrypted: "http://localhost:4318",
    });

    expect(sdk).toBeDefined();
    await sdk?.shutdown();
  });

  it("returns an SDK instance when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    const sdk = startInstrumentation({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
    });

    expect(sdk).toBeDefined();
    expect(mockStart).toHaveBeenCalled();
    await sdk?.shutdown();
  });

  it("picks up OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_unencrypted (SOPS convention)", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    const sdk = startInstrumentation({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_unencrypted: "http://localhost:4318/v1/traces",
    });

    expect(sdk).toBeDefined();
    await sdk?.shutdown();
  });

  it("constructs NodeSDK with span processors, log processors, and instrumentations", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });

    expect(NodeSDK).toHaveBeenCalledOnce();
    const calls = vi.mocked(NodeSDK).mock.calls;
    const config = calls[0]?.[0];
    expect(config).toBeDefined();
    expect(config?.spanProcessors).toHaveLength(1);
    expect(config?.logRecordProcessors).toHaveLength(1);
    expect(config?.instrumentations).toHaveLength(3);
    expect(BatchSpanProcessor).toHaveBeenCalledWith(expect.any(OTLPTraceExporter));
    expect(BatchLogRecordProcessor).toHaveBeenCalledWith(expect.any(OTLPLogExporter));
    expect(WinstonInstrumentation).toHaveBeenCalled();
    expect(HttpInstrumentation).toHaveBeenCalled();
    expect(ExpressInstrumentation).toHaveBeenCalled();
  });

  it("only configures trace processors/instrumentations when only traces endpoint exists", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
    });

    expect(NodeSDK).toHaveBeenCalledOnce();
    const calls = vi.mocked(NodeSDK).mock.calls;
    const config = calls[0]?.[0];
    expect(config).toBeDefined();
    expect(config?.spanProcessors).toHaveLength(1);
    expect(config?.logRecordProcessors).toHaveLength(0);
    expect(config?.instrumentations).toHaveLength(2);
    expect(BatchSpanProcessor).toHaveBeenCalledWith(expect.any(OTLPTraceExporter));
    expect(BatchLogRecordProcessor).not.toHaveBeenCalled();
    expect(WinstonInstrumentation).not.toHaveBeenCalled();
    expect(HttpInstrumentation).toHaveBeenCalled();
    expect(ExpressInstrumentation).toHaveBeenCalled();
  });

  it("only configures log processors/instrumentations when only logs endpoint exists", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4318/v1/logs",
    });

    expect(NodeSDK).toHaveBeenCalledOnce();
    const calls = vi.mocked(NodeSDK).mock.calls;
    const config = calls[0]?.[0];
    expect(config).toBeDefined();
    expect(config?.spanProcessors).toHaveLength(0);
    expect(config?.logRecordProcessors).toHaveLength(1);
    expect(config?.instrumentations).toHaveLength(1);
    expect(BatchSpanProcessor).not.toHaveBeenCalled();
    expect(BatchLogRecordProcessor).toHaveBeenCalledWith(expect.any(OTLPLogExporter));
    expect(WinstonInstrumentation).toHaveBeenCalled();
    expect(HttpInstrumentation).not.toHaveBeenCalled();
    expect(ExpressInstrumentation).not.toHaveBeenCalled();
  });

  it("does not override configured endpoint with *_unencrypted fallback", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://process.example";

    startInstrumentation({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://configured.example",
      OTEL_EXPORTER_OTLP_ENDPOINT_unencrypted: "https://fallback.example",
    });

    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://process.example");
  });

  it("registers SIGTERM and SIGINT handlers that call sdk.shutdown", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });

    expect(process.listenerCount("SIGTERM")).toBe(sigTermCountBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigIntCountBefore + 1);

    // Trigger the SIGTERM handler and verify it calls shutdown
    const sigTermHandler = process.listeners("SIGTERM").at(-1);
    expect(sigTermHandler).toBeDefined();
    if (typeof sigTermHandler === "function") {
      sigTermHandler("SIGTERM");
    }
    expect(mockShutdown).toHaveBeenCalledOnce();
  });
});
