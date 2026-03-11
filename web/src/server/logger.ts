import * as winston from "winston";
import TransportStream from "winston-transport";

// ── Ring buffer transport for UI consumption ──

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

const MAX_ENTRIES = 500;
const ringBuffer: LogEntry[] = [];

class RingBufferTransport extends TransportStream {
  override log(
    info: { level: string; message: string; [key: string]: unknown },
    callback: () => void,
  ) {
    ringBuffer.push({
      timestamp: new Date().toISOString(),
      level: info.level,
      message: info.message,
    });
    if (ringBuffer.length > MAX_ENTRIES) {
      ringBuffer.splice(0, ringBuffer.length - MAX_ENTRIES);
    }
    callback();
  }
}

/** Read the most recent log entries (for the UI system logs endpoint). */
export function getSystemLogs(limit = 200): LogEntry[] {
  return ringBuffer.slice(-limit);
}

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
    new RingBufferTransport(),
  ],
});
