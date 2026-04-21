import { SpanStatusCode, trace } from "@opentelemetry/api";

declare const __COMMIT_HASH__: string;

let initialized = false;

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function withSpan(spanName: string, callback: (span: import("@opentelemetry/api").Span) => void) {
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    callback(activeSpan);
    return;
  }

  const span = trace.getTracer("dofek.web.telemetry").startSpan(spanName);
  try {
    callback(span);
  } finally {
    span.end();
  }
}

export function initTelemetry() {
  if (initialized) {
    return;
  }
  initialized = true;
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  initTelemetry();
  const errorObject = ensureError(error);
  withSpan("web.error.capture", (span) => {
    span.recordException(errorObject);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorObject.message,
    });
    span.setAttribute("app.release", __COMMIT_HASH__);
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined || value === null) continue;
      span.setAttribute(`error.${key}`, String(value));
    }
  });
}
