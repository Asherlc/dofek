import { AsyncLocalStorage } from "node:async_hooks";
import * as winston from "winston";
import Transport from "winston-transport";

// Winston logger for the sync runner, providers, and worker code.
// Uses @opentelemetry/winston-transport to bridge logs to OTel directly
// (WinstonInstrumentation doesn't work in ESM apps).

/** Minimal interface matching BullMQ's Job.log() */
interface JobLike {
  log(row: string): Promise<number>;
}

/** AsyncLocalStorage that holds the current BullMQ job (if any). */
export const jobContext = new AsyncLocalStorage<JobLike>();

/**
 * Winston transport that forwards log entries to BullMQ's job.log().
 * Only active when called within a jobContext.run() scope.
 */
class BullJobTransport extends Transport {
  log(info: { message: string; level: string }, callback: () => void) {
    const job = jobContext.getStore();
    if (job) {
      job.log(`[${info.level}] ${info.message}`).catch(() => {});
    }
    callback();
  }
}

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
    new BullJobTransport(),
  ],
});

// Add OTel transport when OTLP log export is configured (production).
// Done lazily to avoid loading OTel packages in tests.
const hasOtelLogExport =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
if (hasOtelLogExport) {
  import("@opentelemetry/winston-transport").then(({ OpenTelemetryTransportV3 }) => {
    logger.add(new OpenTelemetryTransportV3());
  });
}
