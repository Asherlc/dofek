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
