import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import * as Sentry from "@sentry/react-native";

const SENTRY_DSN: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN;
const OTEL_ENDPOINT: string | undefined = process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
const OTEL_HEADERS: string | undefined = process.env.EXPO_PUBLIC_OTEL_HEADERS;

let initialized = false;
let loggerProvider: LoggerProvider | undefined;

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index > 0) {
      headers[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
  }
  return headers;
}

function sanitizeLogAttributes(
  data?: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  if (!data) {
    return undefined;
  }

  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[key] = value;
    }
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

export function initTelemetry() {
  if (initialized) {
    return;
  }
  initialized = true;

  if (!SENTRY_DSN) {
    throw new Error("EXPO_PUBLIC_SENTRY_DSN is not set — Sentry cannot initialize");
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    debug: __DEV__,
  });
  // Verify the Sentry pipeline is working end-to-end
  Sentry.captureMessage("Sentry initialized on iOS", "info");

  if (OTEL_ENDPOINT) {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "dofek-mobile",
    });

    const exporter = new OTLPLogExporter({
      url: OTEL_ENDPOINT,
      headers: OTEL_HEADERS ? parseHeaders(OTEL_HEADERS) : undefined,
    });

    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(exporter)],
    });
  }
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  Sentry.captureException(error, { extra: context });
  const errorMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const attributes =
    error instanceof Error ? { ...context, errorName: error.name } : { ...context };
  emitLog(SeverityNumber.ERROR, "ERROR", "exception", errorMessage, attributes);
}

function emitLog(
  severityNumber: SeverityNumber,
  severityText: string,
  category: string,
  message: string,
  data?: Record<string, unknown>,
) {
  if (loggerProvider) {
    const otelLogger = loggerProvider.getLogger(category);
    otelLogger.emit({
      severityNumber,
      severityText,
      body: `[${category}] ${message}`,
      attributes: sanitizeLogAttributes(data),
    });
  }
}

/**
 * Structured logger backed by OpenTelemetry.
 *
 * When EXPO_PUBLIC_OTEL_ENDPOINT is set, log records are exported via
 * OTLP/HTTP to the configured collector (e.g. Axiom). Always also writes
 * to console for local development visibility.
 */
export const logger = {
  info(category: string, message: string, data?: Record<string, unknown>) {
    emitLog(SeverityNumber.INFO, "INFO", category, message, data);
    console.log(`[${category}] ${message}`);
  },
  warn(category: string, message: string, data?: Record<string, unknown>) {
    emitLog(SeverityNumber.WARN, "WARN", category, message, data);
    console.warn(`[${category}] ${message}`);
  },
  error(category: string, message: string, data?: Record<string, unknown>) {
    emitLog(SeverityNumber.ERROR, "ERROR", category, message, data);
    console.error(`[${category}] ${message}`);
  },
};

/** Flush pending log records (call before app exits or backgrounds). */
export async function flushTelemetry(): Promise<void> {
  await loggerProvider?.forceFlush();
}
