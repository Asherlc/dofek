import { describe, expect, it } from "vitest";
import { logger } from "./logger.ts";

describe("logger", () => {
  it("logs messages without throwing", () => {
    expect(() => logger.info("test message")).not.toThrow();
    expect(() => logger.warn("test warning")).not.toThrow();
    expect(() => logger.error("test error")).not.toThrow();
  });
});
