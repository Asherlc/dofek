import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
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
  let sigTermCountBefore: number;
  let sigIntCountBefore: number;

  beforeEach(() => {
    originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    sigTermCountBefore = process.listenerCount("SIGTERM");
    sigIntCountBefore = process.listenerCount("SIGINT");
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    // Remove signal handlers added during the test (added at the end by startInstrumentation)
    removeExtraListeners("SIGTERM", sigTermCountBefore);
    removeExtraListeners("SIGINT", sigIntCountBefore);
  });

  it("exports startInstrumentation function", async () => {
    const mod = await import("./instrumentation.ts");
    expect(typeof mod.startInstrumentation).toBe("function");
  });

  it("returns undefined when OTEL_EXPORTER_OTLP_ENDPOINT is not set", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
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
});
