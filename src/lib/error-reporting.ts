import {
  captureException as sentryCaptureException,
  type CaptureContext,
  type EventHint,
  type ScopeContext,
} from "@sentry/node";
import { capturePostHogException } from "./posthog.ts";

function flattenCaptureContext(captureContext?: CaptureContext): Record<string, unknown> {
  if (!captureContext) {
    return {};
  }

  if (typeof captureContext === "string") {
    return { captureContext };
  }

  const properties: Record<string, unknown> = {};
  const context = captureContext as ScopeContext;

  if (context.tags) {
    for (const [key, value] of Object.entries(context.tags)) {
      properties[`tag_${key}`] = value;
    }
  }

  if (context.extra) {
    Object.assign(properties, context.extra);
  }

  if (context.contexts) {
    properties.contexts = context.contexts;
  }

  if (context.fingerprint) {
    properties.fingerprint = context.fingerprint;
  }

  if (context.level) {
    properties.level = context.level;
  }

  return properties;
}

/**
 * Reports an exception to Sentry and PostHog error tracking.
 */
export function captureException(
  exception: unknown,
  captureContext?: CaptureContext,
  hint?: EventHint,
): string {
  const eventId =
    hint !== undefined
      ? sentryCaptureException(exception, captureContext, hint)
      : captureContext !== undefined
        ? sentryCaptureException(exception, captureContext)
        : sentryCaptureException(exception);
  capturePostHogException(exception, undefined, flattenCaptureContext(captureContext));
  return eventId;
}
