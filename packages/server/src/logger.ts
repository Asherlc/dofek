import { Writable } from "node:stream";
import * as winston from "winston";
import { RingBuffer } from "./lib/ring-buffer-transport.ts";

// ── Ring buffer for in-memory log access via API ──

export const logBuffer = new RingBuffer(500);

const ringBufferStream = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    // Each line from winston is a formatted log string — parse it back into structured data.
    // The format produces: "TIMESTAMP [LEVEL] MESSAGE"
    const line = chunk.toString().trim();
    const match = line.match(/^(\S+)\s+\[(\w+)]\s+(.*)$/s);
    if (match?.[1] && match[2] && match[3]) {
      logBuffer.push({ timestamp: match[1], level: match[2], message: match[3] });
    } else {
      logBuffer.push({ timestamp: new Date().toISOString(), level: "info", message: line });
    }
    callback();
  },
});

// ── Logger instance ──

export const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message }) => `${level}: ${message}`),
      ),
    }),
    new winston.transports.Stream({ stream: ringBufferStream }),
  ],
});
