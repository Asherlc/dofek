import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import * as Sentry from "@sentry/react-native";
import type { AuthUser } from "./auth";
import PostHog from "posthog-react-native";

const SENTRY_DSN: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN;
const OTEL_ENDPOINT: string | undefined = process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
const OTEL_HEADERS: string | undefined = process.env.EXPO_PUBLIC_OTEL_HEADERS;
const POSTHOG_API_KEY = "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg";
const POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_LOGS_URL = `${POSTHOG_HOST}/i/v1/logs`;

let initialized = false;
let loggerProvider: LoggerProvider | undefined;
let posthogClient: PostHog | undefined;

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

function sentryBreadcrumbLevel(severityText: string): "info" | "warning" | "error" {
  switch (severityText) {
    case "ERROR":
      return "error";
    case "WARN":
      return "warning";
    default:
      return "info";
  }
}

function createLogProcessors(): BatchLogRecordProcessor[] {
  const processors: BatchLogRecordProcessor[] = [];

  if (OTEL_ENDPOINT) {
    processors.push(
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: OTEL_ENDPOINT,
          headers: OTEL_HEADERS ? parseHeaders(OTEL_HEADERS) : undefined,
        }),
      }),
    );
  }

  if (!__DEV__) {
    processors.push(
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: POSTHOG_LOGS_URL,
          headers: {
            Authorization: `Bearer ${POSTHOG_API_KEY}`,
          },
        }),
      }),
    );
  }

  return processors;
}

export function identifyPostHogUser(user: AuthUser): void {
  posthogClient?.identify(user.id, {
    email: user.email,
    name: user.name,
  });
}

export function resetPostHogUser(): void {
  posthogClient?.reset();
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
    tracesSampler: ({ name, inheritOrSampleWith }) =>
      name === "App Start" || name === "Mobile Startup" ? 1 : inheritOrSampleWith(0),
  });

  if (!__DEV__) {
    posthogClient = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      errorTracking: {
        autocapture: {
          uncaughtExceptions: true,
          unhandledRejections: true,
          console: ["error"],
        },
      },
    });
    posthogClient.register({ service: "dofek-mobile" });
  }

  const logProcessors = createLogProcessors();
  if (logProcessors.length > 0) {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "dofek-mobile",
    });

    loggerProvider = new LoggerProvider({
      resource,
      processors: logProcessors,
    });
  }
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  const source = typeof context.source === "string" ? context.source : undefined;
  Sentry.captureException(error, {
    ...(source ? { tags: { source } } : {}),
    extra: context,
  });
  posthogClient?.captureException(error, context);
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
  const sanitizedData = sanitizeLogAttributes(data);
  Sentry.addBreadcrumb({
    category,
    message,
    level: sentryBreadcrumbLevel(severityText),
    ...(sanitizedData ? { data: sanitizedData } : {}),
  });

  if (loggerProvider) {
    const otelLogger = loggerProvider.getLogger(category);
    otelLogger.emit({
      severityNumber,
      severityText,
      body: `[${category}] ${message}`,
      attributes: sanitizedData,
    });
  }
}

/**
 * Structured logger backed by OpenTelemetry.
 *
 * When EXPO_PUBLIC_OTEL_ENDPOINT is set, log records are exported via
 * OTLP/HTTP to the configured collector (e.g. Axiom). In production, logs
 * are also exported to PostHog. Always also writes to console for local
 * development visibility.
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
  if (posthogClient) {
    await posthogClient.flush();
  }
}
