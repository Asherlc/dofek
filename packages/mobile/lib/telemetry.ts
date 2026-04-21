import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

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

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function normalizeAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!attributes) {
    return undefined;
  }

  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

export function initTelemetry() {
  if (initialized) {
    return;
  }
  initialized = true;

  if (!OTEL_ENDPOINT) {
    return;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: "dofek-mobile",
  });

  const exporter = new OTLPLogExporter({
    url: OTEL_ENDPOINT,
    headers: OTEL_HEADERS ? parseHeaders(OTEL_HEADERS) : undefined,
  });

  loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter));

  captureMessage("Mobile telemetry initialized", "info");
}

function emitLog(
  severityNumber: SeverityNumber,
  severityText: string,
  category: string,
  message: string,
  attributes?: Record<string, unknown>,
) {
  if (loggerProvider) {
    const otelLogger = loggerProvider.getLogger(category);
    otelLogger.emit({
      severityNumber,
      severityText,
      body: `[${category}] ${message}`,
      attributes: normalizeAttributes(attributes),
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

export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context: Record<string, unknown> = {},
) {
  const category = "telemetry";
  const levelLabel = level.toUpperCase();
  if (level === "error") {
    logger.error(category, message, context);
    return;
  }
  if (level === "warning") {
    logger.warn(category, message, context);
    return;
  }
  emitLog(SeverityNumber.INFO, levelLabel, category, message, context);
  console.log(`[${category}] ${message}`);
}

export function addBreadcrumb(
  category: string,
  message: string,
  level: "info" | "warning" | "error" = "info",
  data?: Record<string, unknown>,
) {
  const attributes = data ? { ...data, breadcrumb: true } : { breadcrumb: true };
  captureMessage(`[${category}] ${message}`, level, attributes);
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  const normalizedError = normalizeError(error);
  logger.error("exception", normalizedError.message, {
    ...context,
    errorName: normalizedError.name,
    errorStack: normalizedError.stack ?? "",
  });
}

/** Flush pending log records (call before app exits or backgrounds). */
export async function flushTelemetry(): Promise<void> {
  await loggerProvider?.forceFlush();
}
