import {
  captureException as sentryCaptureException,
  type CaptureContext,
} from "@sentry/node";
import { capturePostHogException } from "./posthog.ts";

type ScopeContextLike = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  fingerprint?: string[];
  level?: string;
};

function flattenCaptureContext(captureContext?: CaptureContext): Record<string, unknown> {
  if (!captureContext) {
    return {};
  }

  if (typeof captureContext === "string" || typeof captureContext === "function") {
    return { captureContext: typeof captureContext };
  }

  const properties: Record<string, unknown> = {};
  const context = captureContext as ScopeContextLike;

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
): string {
  const eventId =
    captureContext !== undefined
      ? sentryCaptureException(exception, captureContext)
      : sentryCaptureException(exception);
  capturePostHogException(exception, undefined, flattenCaptureContext(captureContext));
  return eventId;
}
