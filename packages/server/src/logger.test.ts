import { describe, expect, it } from "vitest";
import { getSystemLogs, logger } from "./logger.ts";

describe("logger", () => {
  it("records log entries in the ring buffer", () => {
    const before = getSystemLogs().length;
    logger.info("test message");
    const after = getSystemLogs();
    expect(after.length).toBe(before + 1);
    const last = after[after.length - 1];
    expect(last?.message).toBe("test message");
    expect(last?.level).toBe("info");
    expect(last?.timestamp).toBeTruthy();
  });

  it("ring buffer evicts old entries when exceeding 500", () => {
    // Fill the buffer past 500 entries
    for (let i = 0; i < 510; i++) {
      logger.info(`overflow-${i}`);
    }
    const logs = getSystemLogs();
    expect(logs.length).toBeLessThanOrEqual(500);
  });

  it("getSystemLogs respects limit parameter", () => {
    logger.info("limit-test-1");
    logger.info("limit-test-2");
    logger.info("limit-test-3");
    const limited = getSystemLogs(2);
    expect(limited.length).toBeLessThanOrEqual(2);
  });
});
