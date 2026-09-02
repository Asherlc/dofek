import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as winston from "winston";
import { jobContext, logger } from "./logger.ts";
import {
  CaptureInfoTransport,
  consoleTransportFormat,
  createCaptureLogger,
} from "./test-helpers.ts";

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
      format: consoleTransportFormat(),
    });
    const captureLogger = createCaptureLogger(capture);

    captureLogger.info("capture test");
    captureLogger.close();

    expect(output.length).toBeGreaterThan(0);
    expect(output[0]).toContain("info");
    expect(output[0]).toContain("capture test");
  });

  it("interpolates one and multiple substitution arguments for console output", () => {
    const output: string[] = [];
    const capture = new winston.transports.Stream({
      stream: new Writable({
        write(chunk: Buffer, _encoding: string, callback: () => void) {
          output.push(chunk.toString());
          callback();
        },
      }),
      format: consoleTransportFormat(),
    });
    const captureLogger = createCaptureLogger(capture);

    captureLogger.info("Imported FIT file %s", "activity.fit");
    captureLogger.error(
      "Failed to mark export %s as failed: %s",
      "export-42",
      "database unavailable",
    );
    captureLogger.close();

    expect(output).toEqual([
      expect.stringContaining("Imported FIT file activity.fit"),
      expect.stringContaining("Failed to mark export export-42 as failed: database unavailable"),
    ]);
    expect(output.join("\n")).not.toContain("%s");
  });

  it("provides interpolated messages in the info shape consumed by OTel", async () => {
    const capture = new CaptureInfoTransport();
    const captureLogger = createCaptureLogger(capture);

    try {
      captureLogger.warn("Advisory unlock failed for %s: %s", "migration-7", "connection closed");
      await vi.waitFor(() => expect(capture.entries).toHaveLength(1));
    } finally {
      captureLogger.close();
    }

    expect(capture.entries).toEqual([
      {
        level: "warn",
        message: "Advisory unlock failed for migration-7: connection closed",
      },
    ]);
  });

  it("preserves Error messages and stacks during interpolation", async () => {
    const capture = new CaptureInfoTransport();
    const redisError = new Error("Redis connection closed");
    const captureLogger = createCaptureLogger(capture);

    try {
      captureLogger.warn("Advisory unlock failed: %s", redisError);
      await vi.waitFor(() => expect(capture.entries).toHaveLength(1));
    } finally {
      captureLogger.close();
    }

    expect(capture.entries[0]?.message).toContain("Error: Redis connection closed");
    expect(capture.entries[0]?.message).toContain(redisError.stack);
  });

  it("keeps sanitized FIT values interpolated across transports", async () => {
    const capture = new CaptureInfoTransport();
    const captureLogger = createCaptureLogger(capture);

    try {
      captureLogger.error(
        "Failed to import FIT file %s: %s",
        "[redacted]_activity.fit",
        "Native decoder rejected token=[REDACTED]",
      );
      await vi.waitFor(() => expect(capture.entries).toHaveLength(1));
    } finally {
      captureLogger.close();
    }

    expect(capture.entries[0]?.message).toBe(
      "Failed to import FIT file [redacted]_activity.fit: Native decoder rejected token=[REDACTED]",
    );
    expect(capture.entries[0]?.message).not.toContain("%s");
  });

  it("forwards logs to job.log() when inside jobContext", async () => {
    const mockJob = { log: vi.fn().mockResolvedValue(1) };

    await jobContext.run(mockJob, async () => {
      logger.info("test message");
      await vi.waitFor(() =>
        expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining("test message")),
      );
    });
  });

  it("formats BullJobTransport output with level prefix", async () => {
    const mockJob = { log: vi.fn().mockResolvedValue(1) };

    await jobContext.run(mockJob, async () => {
      logger.warn("Failed to update export %s: %s", "export-42", "Redis unavailable");
      await vi.waitFor(() =>
        expect(mockJob.log).toHaveBeenCalledWith(
          "[warn] Failed to update export export-42: Redis unavailable",
        ),
      );
    });
  });

  it("does not throw when job.log() rejects", async () => {
    const mockJob = { log: vi.fn().mockRejectedValue(new Error("Redis gone")) };

    await jobContext.run(mockJob, async () => {
      // Should not throw even when job.log rejects
      expect(() => logger.info("will fail to log")).not.toThrow();
      await vi.waitFor(() => expect(mockJob.log).toHaveBeenCalled());
    });
  });

  it("does not call job.log() when outside jobContext", () => {
    const mockJob = { log: vi.fn() };
    // Logging outside jobContext should not throw and not call any job
    expect(() => logger.info("no job context")).not.toThrow();
    expect(mockJob.log).not.toHaveBeenCalled();
  });
});
