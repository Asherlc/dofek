import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

const TRACER_NAME = "dofek-ios";
const OTLP_TRACES_ENDPOINT: string | undefined =
  process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
  process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT;
const OTLP_TRACES_HEADERS: string | undefined =
  process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
  process.env.EXPO_PUBLIC_OTEL_EXPORTER_OTLP_HEADERS;

let initialized = false;
let telemetryEnabled = false;
let fetchWrapped = false;

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsType = {
  getGlobalHandler?: () => ErrorHandler;
  setGlobalHandler?: (handler: ErrorHandler) => void;
};

function isRequestInput(input: RequestInfo | URL): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

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

function installGlobalErrorHandler() {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsType }).ErrorUtils;
  const originalHandler = errorUtils?.getGlobalHandler?.();
  if (!errorUtils?.setGlobalHandler) {
    return;
  }

  errorUtils.setGlobalHandler((error, isFatal) => {
    captureException(error, {
      "error.source": "react-native.global",
      "error.fatal": isFatal ? 1 : 0,
    });
    originalHandler?.(error, isFatal);
  });
}

function installFetchTracing() {
  if (fetchWrapped || typeof globalThis.fetch !== "function") {
    return;
  }
  fetchWrapped = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    const tracer = trace.getTracer(TRACER_NAME);
    const requestInput = isRequestInput(input) ? input : undefined;
    const url =
      typeof input === "string"
        ? input
        : typeof URL !== "undefined" && input instanceof URL
          ? input.toString()
          : String(requestInput?.url ?? "unknown");
    const method = init?.method ?? requestInput?.method ?? "GET";

    const span = tracer.startSpan("http.client", {
      attributes: {
        "http.request.method": method,
        "url.full": url,
      },
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);

        const headers = new Headers(requestInput?.headers);
        if (init?.headers) {
          for (const [key, value] of new Headers(init.headers).entries()) {
            headers.set(key, value);
          }
        }
        for (const [key, value] of Object.entries(carrier)) {
          headers.set(key, value);
        }

        const response = await originalFetch(input, { ...init, headers });
        span.setAttribute("http.response.status_code", response.status);
        return response;
      } catch (error) {
        const normalized = toError(error);
        span.recordException(normalized);
        span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
        throw error;
      } finally {
        span.end();
      }
    });
  };
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
  const provider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );

  installFetchTracing();
  installGlobalErrorHandler();
  telemetryEnabled = true;
}

export function captureException(error: unknown, attributes: Attributes = {}) {
  if (!telemetryEnabled) {
    return;
  }

  const normalized = toError(error);
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan("mobile.exception", {
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
