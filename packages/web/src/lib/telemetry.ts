import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const TRACER_NAME = "dofek-web";
const TRACE_PROPAGATION_TARGETS = [/^\/api/, /^\/auth/, /^\/callback/];
const OTLP_TRACES_ENDPOINT: string | undefined =
  import.meta.env.VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT;
const OTLP_TRACES_HEADERS: string | undefined =
  import.meta.env.VITE_OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
  import.meta.env.VITE_OTEL_EXPORTER_OTLP_HEADERS;

let telemetryEnabled = false;
let initialized = false;

function parseHeaders(headers: string | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const entries = headers
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx <= 0) {
        return undefined;
      }
      return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()] as const;
    })
    .filter((pair): pair is readonly [string, string] => Boolean(pair?.[0] && pair[1]));

  if (!entries.length) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : String(error));
}

function addGlobalErrorHandlers() {
  window.addEventListener("error", (event) => {
    captureException(event.error ?? event.message, {
      "error.source": "window.onerror",
      "error.filename": event.filename ?? "",
      "error.lineno": event.lineno ?? 0,
      "error.colno": event.colno ?? 0,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    captureException(event.reason, { "error.source": "window.unhandledrejection" });
  });
}

export function initTelemetry() {
  if (initialized) {
    return;
  }
  initialized = true;

  if (!OTLP_TRACES_ENDPOINT) {
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: OTLP_TRACES_ENDPOINT,
    headers: parseHeaders(OTLP_TRACES_HEADERS),
  });
  const provider = new WebTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register();

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: TRACE_PROPAGATION_TARGETS,
      }),
      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls: TRACE_PROPAGATION_TARGETS,
      }),
    ],
  });

  telemetryEnabled = true;
  addGlobalErrorHandlers();
}

export function captureException(error: unknown, attributes: Attributes = {}) {
  if (!telemetryEnabled) {
    return;
  }

  const normalized = toError(error);
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan("ui.exception", {
    attributes: {
      "exception.type": normalized.name,
      "exception.message": normalized.message,
      ...attributes,
    },
  });

  span.recordException(normalized);
  span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
  span.end();
}
