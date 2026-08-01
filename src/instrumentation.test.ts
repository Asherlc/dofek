import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTHOG_API_KEY, POSTHOG_HOST } from "./lib/posthog-config.ts";

const mockStart = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);
const mockAutoInstrumentations = { bundle: "auto" };

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn().mockImplementation(() => ({
    start: mockStart,
    shutdown: mockShutdown,
  })),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({}),
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  BatchSpanProcessor: vi.fn(),
}));

vi.mock("@posthog/ai/otel", () => ({
  PostHogSpanProcessor: vi.fn().mockImplementation(() => ({
    forceFlush: vi.fn().mockResolvedValue(undefined),
    onEnd: vi.fn(),
    onStart: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: vi.fn(),
}));

vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: vi.fn(() => mockAutoInstrumentations),
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
  let originalMetricsEndpoint: string | undefined;
  let originalDeploymentEnvironment: string | undefined;
  let sigTermCountBefore: number;
  let sigIntCountBefore: number;

  beforeEach(() => {
    originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    originalTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    originalLogsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    originalMetricsEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    originalDeploymentEnvironment = process.env.DEPLOY_ENVIRONMENT;
    sigTermCountBefore = process.listenerCount("SIGTERM");
    sigIntCountBefore = process.listenerCount("SIGINT");
    vi.mocked(NodeSDK).mockClear();
    vi.mocked(OTLPTraceExporter).mockClear();
    vi.mocked(OTLPLogExporter).mockClear();
    vi.mocked(OTLPMetricExporter).mockClear();
    vi.mocked(BatchSpanProcessor).mockClear();
    vi.mocked(PostHogSpanProcessor).mockClear();
    vi.mocked(BatchLogRecordProcessor).mockClear();
    vi.mocked(PeriodicExportingMetricReader).mockClear();
    vi.mocked(getNodeAutoInstrumentations).mockClear();
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
    if (originalMetricsEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = originalMetricsEndpoint;
    }
    if (originalDeploymentEnvironment === undefined) {
      delete process.env.DEPLOY_ENVIRONMENT;
    } else {
      process.env.DEPLOY_ENVIRONMENT = originalDeploymentEnvironment;
    }
    removeExtraListeners("SIGTERM", sigTermCountBefore);
    removeExtraListeners("SIGINT", sigIntCountBefore);
  });

  it("exports startInstrumentation function", async () => {
    const mod = await import("./instrumentation.ts");
    expect(typeof mod.startInstrumentation).toBe("function");
  });

  it("returns undefined when no OTLP endpoints are set and not in production", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
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

  it("returns an SDK instance when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    const sdk = startInstrumentation({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
    });

    expect(sdk).toBeDefined();
    expect(mockStart).toHaveBeenCalled();
    await sdk?.shutdown();
  });

  it("constructs NodeSDK with span processors, log processors, metric reader, and auto instrumentations", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });

    expect(NodeSDK).toHaveBeenCalledOnce();
    const config = vi.mocked(NodeSDK).mock.calls[0]?.[0];
    expect(config?.spanProcessors).toHaveLength(2);
    expect(config?.logRecordProcessors).toHaveLength(1);
    expect(config?.metricReader).toBeDefined();
    expect(config?.instrumentations).toEqual([mockAutoInstrumentations]);
    expect(BatchSpanProcessor).toHaveBeenCalledWith(expect.any(OTLPTraceExporter));
    expect(PostHogSpanProcessor).not.toHaveBeenCalled();
    expect(BatchLogRecordProcessor).toHaveBeenCalledWith({
      exporter: expect.any(OTLPLogExporter),
    });
    expect(PeriodicExportingMetricReader).toHaveBeenCalledWith(
      expect.objectContaining({ exporter: expect.any(OTLPMetricExporter) }),
    );
    expect(getNodeAutoInstrumentations).toHaveBeenCalledWith({
      "@opentelemetry/instrumentation-winston": { enabled: false },
    });
  });

  it("adds the PostHog AI processor in production without enabling generic auto-instrumentations", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({ DEPLOY_ENVIRONMENT: "production" });

    const config = vi.mocked(NodeSDK).mock.calls.at(-1)?.[0];
    expect(config?.spanProcessors).toHaveLength(2);
    expect(config?.instrumentations).toEqual([]);
    expect(PostHogSpanProcessor).toHaveBeenCalledWith({
      projectToken: POSTHOG_API_KEY,
      host: POSTHOG_HOST,
    });
    expect(getNodeAutoInstrumentations).not.toHaveBeenCalled();
  });

  it("keeps Axiom and PostHog AI processors together in production", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({
      DEPLOY_ENVIRONMENT: "production",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    });

    const config = vi.mocked(NodeSDK).mock.calls.at(-1)?.[0];
    expect(config?.spanProcessors).toHaveLength(3);
    expect(BatchSpanProcessor).toHaveBeenCalledOnce();
    expect(PostHogSpanProcessor).toHaveBeenCalledOnce();
  });

  it("adds a PostHog log exporter in production even without Axiom endpoints", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({
      DEPLOY_ENVIRONMENT: "production",
    });

    const config = vi.mocked(NodeSDK).mock.calls[0]?.[0];
    expect(config?.logRecordProcessors).toHaveLength(1);
    expect(BatchLogRecordProcessor).toHaveBeenCalledWith({
      exporter: expect.any(OTLPLogExporter),
    });
    expect(OTLPLogExporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.any(String),
        headers: expect.objectContaining({
          Authorization: expect.stringContaining("Bearer "),
        }),
      }),
    );
  });

  it("only configures trace processors and auto instrumentations when only traces endpoint exists", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
    });

    const config = vi.mocked(NodeSDK).mock.calls[0]?.[0];
    expect(config?.spanProcessors).toHaveLength(2);
    expect(config?.logRecordProcessors).toHaveLength(0);
    expect(config?.metricReader).toBeUndefined();
    expect(config?.instrumentations).toEqual([mockAutoInstrumentations]);
    expect(getNodeAutoInstrumentations).toHaveBeenCalledOnce();
  });

  it("only configures log processors when only logs endpoint exists", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://localhost:4318/v1/logs",
    });

    const config = vi.mocked(NodeSDK).mock.calls[0]?.[0];
    expect(config?.spanProcessors).toHaveLength(0);
    expect(config?.logRecordProcessors).toHaveLength(1);
    expect(config?.instrumentations).toEqual([]);
    expect(getNodeAutoInstrumentations).not.toHaveBeenCalled();
  });

  it("configures metric reader when only metrics endpoint exists", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    const sdk = startInstrumentation({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://localhost:4318/v1/metrics",
    });

    const config = vi.mocked(NodeSDK).mock.calls[0]?.[0];
    expect(config?.spanProcessors).toHaveLength(0);
    expect(config?.logRecordProcessors).toHaveLength(0);
    expect(config?.metricReader).toBeDefined();
    expect(config?.instrumentations).toEqual([]);
    expect(PeriodicExportingMetricReader).toHaveBeenCalledWith(
      expect.objectContaining({
        exporter: expect.any(OTLPMetricExporter),
        exportIntervalMillis: 30_000,
      }),
    );
    await sdk?.shutdown();
  });

  it("registers SIGTERM and SIGINT handlers that call sdk.shutdown", async () => {
    const { startInstrumentation } = await import("./instrumentation.ts");

    startInstrumentation({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });

    expect(process.listenerCount("SIGTERM")).toBe(sigTermCountBefore + 1);
    expect(process.listenerCount("SIGINT")).toBe(sigIntCountBefore + 1);

    const sigTermHandler = process.listeners("SIGTERM").at(-1);
    expect(sigTermHandler).toBeDefined();
    if (typeof sigTermHandler === "function") {
      sigTermHandler("SIGTERM");
    }
    expect(mockShutdown).toHaveBeenCalledOnce();
  });
});
