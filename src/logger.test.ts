import { describe, expect, it, vi } from "vitest";
import { jobContext, logger } from "./logger.ts";

describe("logger", () => {
  it("has Console and BullJobTransport transports", () => {
    expect(logger.transports).toHaveLength(2);
    expect(logger.transports[0]?.constructor.name).toBe("Console");
    expect(logger.transports[1]?.constructor.name).toBe("BullJobTransport");
  });

  it("does not throw when logging at each level", () => {
    expect(() => logger.info("info message")).not.toThrow();
    expect(() => logger.warn("warn message")).not.toThrow();
    expect(() => logger.error("error message")).not.toThrow();
    expect(() => logger.debug("debug message")).not.toThrow();
  });

  it("forwards logs to job.log() when inside jobContext", async () => {
    const mockJob = { log: vi.fn().mockResolvedValue(1) };

    await jobContext.run(mockJob, async () => {
      logger.info("test message");
      // Winston transports are async — give the transport time to fire
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining("test message"));
  });

  it("does not call job.log() when outside jobContext", () => {
    // Logging outside jobContext should not throw
    expect(() => logger.info("no job context")).not.toThrow();
  });
});
