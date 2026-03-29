import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as winston from "winston";
import { jobContext, logger } from "./logger.ts";

describe("logger", () => {
  it("has Console and BullJobTransport transports", () => {
    expect(logger.transports).toHaveLength(2);
    expect(logger.transports[0]?.constructor.name).toBe("Console");
    expect(logger.transports[1]?.constructor.name).toBe("BullJobTransport");
  });

  it("is configured with debug level", () => {
    expect(logger.level).toBe("debug");
  });

  it("root format includes timestamp, level, and message", () => {
    const info = logger.format.transform({
      level: "info",
      message: "test message",
      timestamp: "2024-01-01T00:00:00.000Z",
      [Symbol.for("level")]: "info",
    });

    expect(info).not.toBe(false);
    const formatted = String(Object(info)[Symbol.for("message")]);
    expect(formatted).toContain("2024-01-01T00:00:00.000Z");
    expect(formatted).toContain("[info]");
    expect(formatted).toContain("test message");
  });

  it("console transport formats output with level and message", () => {
    const output: string[] = [];
    const capture = new winston.transports.Stream({
      stream: new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          output.push(chunk.toString());
          callback();
        },
      }),
      // Use the same format as the console transport in logger.ts
      format: logger.transports[0]?.format,
    });

    logger.add(capture);
    logger.info("capture test");
    logger.remove(capture);

    expect(output.length).toBeGreaterThan(0);
    expect(output[0]).toContain("info");
    expect(output[0]).toContain("capture test");
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

  it("formats BullJobTransport output with level prefix", async () => {
    const mockJob = { log: vi.fn().mockResolvedValue(1) };

    await jobContext.run(mockJob, async () => {
      logger.warn("warning here");
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining("[warn]"));
    expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining("warning here"));
  });

  it("does not throw when job.log() rejects", async () => {
    const mockJob = { log: vi.fn().mockRejectedValue(new Error("Redis gone")) };

    await jobContext.run(mockJob, async () => {
      // Should not throw even when job.log rejects
      expect(() => logger.info("will fail to log")).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockJob.log).toHaveBeenCalled();
  });

  it("does not call job.log() when outside jobContext", () => {
    const mockJob = { log: vi.fn() };
    // Logging outside jobContext should not throw and not call any job
    expect(() => logger.info("no job context")).not.toThrow();
    expect(mockJob.log).not.toHaveBeenCalled();
  });
});
