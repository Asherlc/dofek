import { describe, expect, it } from "vitest";
import { logger } from "./logger.ts";

describe("logger", () => {
  it("has a single console transport", () => {
    expect(logger.transports).toHaveLength(1);
    expect(logger.transports[0].constructor.name).toBe("Console");
  });

  it("logs messages without throwing", () => {
    expect(() => logger.info("test message")).not.toThrow();
    expect(() => logger.warn("test warning")).not.toThrow();
    expect(() => logger.error("test error")).not.toThrow();
  });

  it("console transport format includes level and message", () => {
    const transport = logger.transports[0];
    const formatted = transport.format?.transform({
      level: "info",
      message: "hello world",
      [Symbol.for("level")]: "info",
    });

    expect(formatted).not.toBe(false);
    if (formatted !== false && formatted !== undefined) {
      const output = String(formatted[Symbol.for("message")]);
      expect(output).toContain("hello world");
      expect(output).toContain("info");
    }
  });

  it("console transport includes only allowlisted structured OIDC diagnostics", () => {
    const transport = logger.transports[0];
    const formatted = transport.format?.transform({
      level: "warn",
      message: "mcp.oidc.token_exchange_failed",
      error_name: "InvalidClientAuth",
      error_description: "invalid client",
      error_detail: "client not found",
      error_cause: "JWKSNoMatchingKey",
      http_status: 401,
      oauth_error: "invalid_client",
      request: { authorization: "must not be rendered" },
      [Symbol.for("level")]: "warn",
    });

    expect(formatted).not.toBe(false);
    if (formatted !== false && formatted !== undefined) {
      const output = String(formatted[Symbol.for("message")]);
      expect(output).toContain('"error_description":"invalid client"');
      expect(output).toContain('"error_detail":"client not found"');
      expect(output).toContain('"error_cause":"JWKSNoMatchingKey"');
      expect(output).toContain('"http_status":401');
      expect(output).not.toContain("must not be rendered");
    }
  });

  it("default format includes timestamp, level, and message", () => {
    const formatted = logger.format.transform({
      level: "info",
      message: "test msg",
      [Symbol.for("level")]: "info",
    });

    expect(formatted).not.toBe(false);
    if (formatted !== false) {
      const output = String(formatted[Symbol.for("message")]);
      expect(output).toContain("test msg");
      expect(output).toContain("info");
      expect(output).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});
