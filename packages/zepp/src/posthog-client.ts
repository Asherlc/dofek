import { POSTHOG_API_KEY, POSTHOG_CAPTURE_URL, POSTHOG_LOGS_URL } from "./posthog-config.ts";

const MAX_BUFFERED_EVENTS = 20;

interface BufferedTelemetryEvent {
  kind: "exception" | "log";
  payload: Record<string, unknown>;
}

let bufferedEvents: BufferedTelemetryEvent[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedError(
  value: unknown,
): value is { message: string; name: string; stack?: string } {
  return isRecord(value) && typeof value.message === "string" && typeof value.name === "string";
}

function normalizeError(error: unknown): { message: string; name: string; stack?: string } {
  if (isNormalizedError(error)) {
    return {
      message: error.message,
      name: error.name,
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  if (typeof error === "string") {
    return { message: error, name: "Error" };
  }
  return { message: String(error), name: "Error" };
}

function getDistinctId(context: Record<string, unknown> = {}): string {
  const fromContext = context.distinctId;
  if (typeof fromContext === "string" && fromContext.trim()) {
    return fromContext.trim();
  }
  return "zepp-unknown";
}

function queueEvent(event: BufferedTelemetryEvent): void {
  bufferedEvents.push(event);
  if (bufferedEvents.length > MAX_BUFFERED_EVENTS) {
    bufferedEvents = bufferedEvents.slice(-MAX_BUFFERED_EVENTS);
  }
}

export function enqueueTelemetryException(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  queueEvent({ kind: "exception", payload: { error: normalizeError(error), context } });
}

export function enqueueTelemetryLog(
  level: string,
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  queueEvent({ kind: "log", payload: { level, category, message, data } });
}

export function serializeBufferedTelemetryEvents(): string {
  return JSON.stringify(bufferedEvents);
}

function isBufferedTelemetryEvent(entry: unknown): entry is BufferedTelemetryEvent {
  if (!isRecord(entry)) {
    return false;
  }
  return entry.kind === "exception" || entry.kind === "log";
}

export function restoreBufferedTelemetryEvents(raw: string | null | undefined): void {
  if (!raw) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    bufferedEvents = parsed.filter(isBufferedTelemetryEvent).slice(-MAX_BUFFERED_EVENTS);
  } catch {
    bufferedEvents = [];
  }
}

export function clearBufferedTelemetryEvents(): void {
  bufferedEvents = [];
}

async function postCaptureEvent(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await fetch({
    url: POSTHOG_CAPTURE_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: POSTHOG_API_KEY,
      event,
      distinct_id: distinctId,
      properties,
    }),
  });
}

async function postOtelLog(
  severityText: string,
  body: string,
  attributes: Record<string, string | number | boolean>,
): Promise<void> {
  const timestampNanos = Date.now() * 1_000_000;
  await fetch({
    url: POSTHOG_LOGS_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${POSTHOG_API_KEY}`,
    },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "dofek-zepp" } }],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(timestampNanos),
                  severityText,
                  body: { stringValue: body },
                  attributes: Object.entries(attributes).map(([key, value]) => ({
                    key,
                    value: { stringValue: String(value) },
                  })),
                },
              ],
            },
          ],
        },
      ],
    }),
  });
}

export async function flushTelemetryEvents(): Promise<void> {
  const pending = [...bufferedEvents];
  bufferedEvents = [];
  for (const entry of pending) {
    if (entry.kind === "exception") {
      const error = entry.payload.error;
      const context = isRecord(entry.payload.context) ? entry.payload.context : {};
      await captureException(error, context);
    } else if (entry.kind === "log") {
      const level = typeof entry.payload.level === "string" ? entry.payload.level : "INFO";
      const category = typeof entry.payload.category === "string" ? entry.payload.category : "zepp";
      const message = typeof entry.payload.message === "string" ? entry.payload.message : "";
      const data = isRecord(entry.payload.data) ? entry.payload.data : undefined;
      await emitLog(level, category, message, data);
    }
  }
}

export async function captureException(
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const normalized = normalizeError(error);
  const distinctId = getDistinctId(context);
  const properties = {
    ...context,
    $exception_type: normalized.name,
    $exception_message: normalized.message,
    ...(normalized.stack ? { $exception_stack_trace_raw: normalized.stack } : {}),
    platform: "zepp",
  };

  try {
    await postCaptureEvent("$exception", distinctId, properties);
  } catch {
    queueEvent({ kind: "exception", payload: { error: normalized, context } });
  }
}

export async function emitLog(
  level: string,
  category: string,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const severityText = level.toUpperCase();
  const attributes: Record<string, string | number | boolean> = {
    category,
    platform: "zepp",
  };
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        attributes[key] = value;
      }
    }
  }

  try {
    await postOtelLog(severityText, `[${category}] ${message}`, attributes);
  } catch {
    queueEvent({ kind: "log", payload: { level, category, message, data } });
  }
}

export const logger = {
  info(category: string, message: string, data?: Record<string, unknown>) {
    void emitLog("INFO", category, message, data);
  },
  warn(category: string, message: string, data?: Record<string, unknown>) {
    void emitLog("WARN", category, message, data);
  },
  error(category: string, message: string, data?: Record<string, unknown>) {
    void emitLog("ERROR", category, message, data);
  },
};
