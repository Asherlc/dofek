import Bugsnag from "@bugsnag/js";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

interface MessageContext {
  level?: "info" | "warning" | "error";
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
}

type ExceptionContext = MessageContext & Record<string, unknown>;

let initialized = false;
let bugsnagEnabled = false;
type BugsnagEvent = {
  addMetadata(section: string, metadata: Record<string, unknown>): void;
  severity: "info" | "warning" | "error";
};
type BugsnagClient = {
  notify(error: Error, onError?: (event: BugsnagEvent) => void): void;
};
let bugsnagClient: BugsnagClient | undefined;

function createBugsnagClient(apiKey: string): BugsnagClient {
  const bugsnagCandidate: unknown = Bugsnag;
  if (
    typeof bugsnagCandidate !== "object" ||
    bugsnagCandidate === null ||
    !("start" in bugsnagCandidate)
  ) {
    throw new Error("BUGSNAG client is unavailable");
  }

  const startMethod = bugsnagCandidate.start;
  if (typeof startMethod !== "function") {
    throw new Error("BUGSNAG start() is unavailable");
  }

  const client = startMethod.call(bugsnagCandidate, { apiKey });
  if (typeof client !== "object" || client === null || !("notify" in client)) {
    throw new Error("BUGSNAG client initialization failed");
  }

  const notifyMethod = client.notify;
  if (typeof notifyMethod !== "function") {
    throw new Error("BUGSNAG notify() is unavailable");
  }

  return {
    notify(error: Error, onError?: (event: BugsnagEvent) => void) {
      const callback = typeof onError === "function" ? onError : undefined;
      notifyMethod.call(client, error, callback);
    },
  };
}

/** @internal - For testing only */
export function __resetTelemetryInitialized() {
  initialized = false;
  bugsnagEnabled = false;
  bugsnagClient = undefined;
}

export function initTelemetry() {
  if (initialized) {
    return;
  }
  initialized = true;

  const errorReporter = process.env.ERROR_REPORTER ?? "otlp";
  if (errorReporter !== "bugsnag") {
    return;
  }

  const apiKey = process.env.BUGSNAG_API_KEY;
  if (!apiKey) {
    throw new Error("BUGSNAG_API_KEY is required when ERROR_REPORTER=bugsnag");
  }

  bugsnagClient = createBugsnagClient(apiKey);
  bugsnagEnabled = true;
}

function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function withSpan(spanName: string, callback: (span: Span) => void) {
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    callback(activeSpan);
    return;
  }

  const span = trace.getTracer("dofek.error-reporting").startSpan(spanName);
  try {
    callback(span);
  } finally {
    span.end();
  }
}

function toAttributeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}

function toMetadata(
  context: MessageContext | Record<string, unknown>,
): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(context)) {
    if (key === "tags" || key === "extra" || key === "level") {
      continue;
    }
    const attributeValue = toAttributeValue(value);
    if (attributeValue !== undefined) {
      metadata[`error.${key}`] = attributeValue;
    }
  }

  const tagsValue = context.tags;
  if (tagsValue && typeof tagsValue === "object" && !Array.isArray(tagsValue)) {
    for (const [key, value] of Object.entries(tagsValue)) {
      const attributeValue = toAttributeValue(value);
      if (attributeValue !== undefined) {
        metadata[`tag.${key}`] = attributeValue;
      }
    }
  }

  const extraValue = context.extra;
  if (extraValue && typeof extraValue === "object" && !Array.isArray(extraValue)) {
    for (const [key, value] of Object.entries(extraValue)) {
      const attributeValue = toAttributeValue(value);
      if (attributeValue !== undefined) {
        metadata[`extra.${key}`] = attributeValue;
      }
    }
  }

  return metadata;
}

function addMetadataToEvent(
  event: BugsnagEvent,
  metadata: Record<string, string | number | boolean>,
) {
  if (Object.keys(metadata).length > 0) {
    event.addMetadata("context", metadata);
  }
}

export function captureException(error: unknown, context: ExceptionContext = {}) {
  initTelemetry();
  const errorObject = ensureError(error);
  const metadata = toMetadata(context);

  if (bugsnagEnabled) {
    bugsnagClient?.notify(errorObject, (event) => {
      addMetadataToEvent(event, metadata);
    });
    return;
  }

  withSpan("error.capture", (span) => {
    span.recordException(errorObject);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorObject.message,
    });
    for (const [key, value] of Object.entries(metadata)) {
      span.setAttribute(key, value);
    }
  });
}

export function captureMessage(message: string, context: MessageContext = {}) {
  initTelemetry();
  const metadata = toMetadata(context);
  const messageLevel = context.level ?? "info";

  if (bugsnagEnabled) {
    bugsnagClient?.notify(new Error(message), (event) => {
      addMetadataToEvent(event, metadata);
      event.severity = messageLevel;
    });
    return;
  }

  withSpan("error.message", (span) => {
    span.addEvent("error.message", {
      "message.text": message,
      "message.level": messageLevel,
      ...metadata,
    });
  });
}
