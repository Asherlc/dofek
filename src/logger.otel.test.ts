import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Transport from "winston-transport";

const otelMocks = vi.hoisted(() => ({
  createTransport: () =>
    class MockOpenTelemetryTransport extends Transport {
      log(_info: unknown, callback: () => void) {
        callback();
      }
    },
}));

vi.mock("@opentelemetry/winston-transport", () => ({
  get OpenTelemetryTransportV3() {
    return otelMocks.createTransport();
  },
}));

describe("logger OTel transport", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    otelMocks.createTransport = () =>
      class MockOpenTelemetryTransport extends Transport {
        log(_info: unknown, callback: () => void) {
          callback();
        }
      };
  });

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  });

  it("does not enable OTel transport without OTLP endpoints", async () => {
    const { logger } = await import("./logger.ts");

    expect(logger.transports).toHaveLength(2);
  });

  it("enables OTel transport when only the logs endpoint is configured", async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://localhost:4318/v1/logs";

    const { logger } = await import("./logger.ts");

    await vi.waitFor(() => {
      expect(logger.transports).toHaveLength(3);
    });
  });

  it("adds OpenTelemetry transport when OTLP endpoint is configured", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const { logger } = await import("./logger.ts");

    await vi.waitFor(() => {
      expect(logger.transports).toHaveLength(3);
    });
  });

  it("logs when OpenTelemetry transport initialization fails", async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://localhost:4318/v1/logs";
    otelMocks.createTransport = () =>
      class FailingTransport extends Transport {
        constructor() {
          super();
          throw new Error("OTel transport unavailable");
        }

        log(_info: unknown, callback: () => void) {
          callback();
        }
      };

    const { logger } = await import("./logger.ts");
    const errorSpy = vi.spyOn(logger, "error");

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to initialize Winston OTel transport: OTel transport unavailable",
      );
    });
  });

  it("stringifies non-Error transport initialization failures", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    otelMocks.createTransport = () =>
      class FailingTransport extends Transport {
        constructor() {
          super();
          throw "transport init failed";
        }

        log(_info: unknown, callback: () => void) {
          callback();
        }
      };

    const { logger } = await import("./logger.ts");
    const errorSpy = vi.spyOn(logger, "error");

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to initialize Winston OTel transport: transport init failed",
      );
    });
  });

  it("formats log output with timestamp, level, and message", async () => {
    const { logger } = await import("./logger.ts");
    const info = logger.format.transform({
      level: "info",
      message: "test message",
      timestamp: "2024-01-01T00:00:00.000Z",
      [Symbol.for("level")]: "info",
    });

    expect(info).not.toBe(false);
    expect(String(Object(info)[Symbol.for("message")])).toBe(
      "2024-01-01T00:00:00.000Z [info] test message",
    );
  });

  it("formats console transport output with level and message", async () => {
    const { logger } = await import("./logger.ts");
    const transport = logger.transports[0];
    expect(transport?.format).toBeDefined();
    if (!transport?.format) {
      return;
    }

    const formatted = transport.format.transform({
      level: "info",
      message: "hello world",
      [Symbol.for("level")]: "info",
    });

    expect(formatted).not.toBe(false);
    expect(String(Object(formatted)[Symbol.for("message")])).toContain("hello world");
    expect(String(Object(formatted)[Symbol.for("message")])).toContain("info");
  });
});
