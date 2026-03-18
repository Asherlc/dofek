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
});
