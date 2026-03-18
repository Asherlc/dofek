import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import * as winston from "winston";
import { logger } from "./logger.ts";

describe("logger", () => {
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
});
