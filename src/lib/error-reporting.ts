import { type CaptureContext, captureException as sentryCaptureException } from "@sentry/node";
import { capturePostHogException } from "./posthog.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenCaptureContext(captureContext?: unknown): Record<string, unknown> {
  if (!captureContext) {
    return {};
  }

  if (typeof captureContext === "string" || typeof captureContext === "function") {
    return { captureContext: typeof captureContext };
  }

  if (!isRecord(captureContext)) {
    return {};
  }

  const properties: Record<string, unknown> = {};

  if (isRecord(captureContext.tags)) {
    for (const [key, value] of Object.entries(captureContext.tags)) {
      if (typeof value === "string") {
        properties[`tag_${key}`] = value;
      }
    }
  }

  if (isRecord(captureContext.extra)) {
    Object.assign(properties, captureContext.extra);
  }

  if (isRecord(captureContext.contexts)) {
    properties.contexts = captureContext.contexts;
  }

  if (Array.isArray(captureContext.fingerprint)) {
    properties.fingerprint = captureContext.fingerprint;
  }

  if (typeof captureContext.level === "string") {
    properties.level = captureContext.level;
  }

  return properties;
}

export { flattenCaptureContext };

/**
 * Reports an exception to Sentry and PostHog error tracking.
 */
export function captureException(exception: unknown, captureContext?: CaptureContext): string {
  const eventId =
    captureContext !== undefined
      ? sentryCaptureException(exception, captureContext)
      : sentryCaptureException(exception);
  capturePostHogException(exception, undefined, flattenCaptureContext(captureContext));
  return eventId;
}
