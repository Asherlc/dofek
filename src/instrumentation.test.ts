import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("instrumentation", () => {
  let originalEndpoint: string | undefined;

  beforeEach(() => {
    originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
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
