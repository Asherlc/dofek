import { describe, expect, it } from "vitest";
import { logger } from "./logger.ts";

describe("logger", () => {
  it("uses a single Console transport", () => {
    expect(logger.transports).toHaveLength(1);
    expect(logger.transports[0]?.constructor.name).toBe("Console");
  });

  it("does not throw when logging at each level", () => {
    expect(() => logger.info("info message")).not.toThrow();
    expect(() => logger.warn("warn message")).not.toThrow();
    expect(() => logger.error("error message")).not.toThrow();
    expect(() => logger.debug("debug message")).not.toThrow();
  });
});
