import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import * as Sentry from "@sentry/react-native";
import PostHog from "posthog-react-native";
import { shouldSuppressBackgroundHealthKitTransientNetworkError } from "./health-kit-errors";

const SENTRY_DSN: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN;
const OTEL_ENDPOINT: string | undefined = process.env.EXPO_PUBLIC_OTEL_ENDPOINT;
const OTEL_HEADERS: string | undefined = process.env.EXPO_PUBLIC_OTEL_HEADERS;
const POSTHOG_API_KEY = "phc_GsvyihTLSXrWGKYYGz84m44nuT59kYEwEXNnI0JICtg";
const POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_LOGS_URL = `${POSTHOG_HOST}/i/v1/logs`;

let initialized = false;
let loggerProvider: LoggerProvider | undefined;
let posthogClient: PostHog | undefined;
let currentTelemetryRoute: string | undefined;

const uuidRouteSegment =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const numericRouteSegment = /^\d+$/;

function normalizeTelemetryRoute(route: string | null | undefined): string | undefined {
  if (!route || route.trim().length === 0) {
    return undefined;
  }

  const path = route.trim().split(/[?#]/, 1)[0];
  if (!path) {
    return undefined;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return normalizedPath
    .split("/")
    .map((segment) =>
      uuidRouteSegment.test(segment) || numericRouteSegment.test(segment) ? ":id" : segment,
    )
    .join("/");
}

export function setTelemetryRoute(route: string | null | undefined): void {
  currentTelemetryRoute = normalizeTelemetryRoute(route);
}

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

type TelemetryUser = {
  id: string;
  email: string | null;
  name: string;
};

export function identifyUser(user: TelemetryUser): void {
  posthogClient?.identify(user.id, {
    email: user.email,
    name: user.name,
  });
}

export function resetUser(): void {
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
        // Autocapture only genuine crashes. Console autocapture is
        // intentionally omitted: React logs recoverable, handled warnings
        // (e.g. "Element type is invalid") via console.error, and our own
        // logger.error writes to console.error too, so capturing the console
        // would mint inbox issues for handled dev-grade warnings and
        // duplicate every error we already report via captureException.
        autocapture: {
          uncaughtExceptions: true,
          unhandledRejections: true,
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

function sanitizePostHogProperties(
  data: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const properties: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      properties[key] = value;
    }
  }
  return properties;
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  const explicitRoute =
    typeof context.route === "string" ? normalizeTelemetryRoute(context.route) : undefined;
  const telemetryContext =
    explicitRoute || currentTelemetryRoute
      ? { ...context, route: explicitRoute ?? currentTelemetryRoute }
      : context;
  const source = typeof context.source === "string" ? context.source : undefined;
  // Suppress non-actionable transient background HealthKit network failures from
  // every error-tracking destination. Applying the check here (rather than only in
  // Sentry's beforeSend) keeps Sentry and PostHog consistent — otherwise the PostHog
  // capture path silently mints error-tracking issues for errors Sentry drops. Logs
  // and breadcrumbs below still record the failure for observability.
  const captureToErrorTracking = !shouldSuppressBackgroundHealthKitTransientNetworkError(
    error,
    source,
  );
  if (captureToErrorTracking) {
    Sentry.captureException(error, {
      ...(source ? { tags: { source } } : {}),
      extra: telemetryContext,
    });
    posthogClient?.captureException(error, sanitizePostHogProperties(telemetryContext));
  }
  const errorMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const attributes =
    error instanceof Error
      ? { ...telemetryContext, errorName: error.name }
      : { ...telemetryContext };
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
