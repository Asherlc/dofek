import { beforeEach, describe, expect, it } from "vitest";
import { logBuffer } from "../logger.ts";

describe("system.logs", () => {
  beforeEach(() => {
    // Clear the shared buffer between tests by replacing internals
    // We need to push enough to fill and wrap, or just test getEntries
  });

  it("logBuffer captures entries pushed to it", () => {
    const before = logBuffer.getEntries().length;
    logBuffer.push({ level: "info", message: "test entry", timestamp: "2026-01-01T00:00:00Z" });
    const after = logBuffer.getEntries();
    expect(after.length).toBeGreaterThan(before);
    expect(after[after.length - 1].message).toBe("test entry");
  });
});
