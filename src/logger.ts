import * as winston from "winston";

// OTel's WinstonInstrumentation auto-captures log records when active.
// This logger is for the sync runner and root src/ code.

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
  ],
});
