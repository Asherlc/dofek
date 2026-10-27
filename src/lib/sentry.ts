import * as Sentry from "@sentry/node";
import { initProductionPostHog } from "./posthog.ts";
import {
  redactTelemetryAttributes,
  redactTelemetryQuery,
  redactTelemetryUrl,
} from "./telemetry-url.ts";

const SENTRY_ENVIRONMENT = "production";
const ACCOUNT_ERASURE_DATABASE_FENCE_CODE = "55000";
const ACCOUNT_ERASURE_DATABASE_FENCE_MESSAGE = "Account erasure is active for user";
const ACCOUNT_ERASURE_FENCE_ERROR_NAMES = new Set([
  "AccountErasureIdentityFencedError",
  "AccountErasureUserFencedError",
]);
let initialized = false;
type SentrySpan = Parameters<NonNullable<Sentry.NodeOptions["beforeSendSpan"]>>[0];

function isProductionDeployment(environment: string | undefined): boolean {
  return environment === "prod" || environment === "production";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isExpectedAccountErasureFence(error: unknown): boolean {
  const visited = new Set<unknown>();
  let candidate: unknown = error;
  while (isRecord(candidate) && !visited.has(candidate)) {
    visited.add(candidate);
    if (
      (typeof candidate.name === "string" &&
        ACCOUNT_ERASURE_FENCE_ERROR_NAMES.has(candidate.name)) ||
      (candidate.code === ACCOUNT_ERASURE_DATABASE_FENCE_CODE &&
        typeof candidate.message === "string" &&
        candidate.message.includes(ACCOUNT_ERASURE_DATABASE_FENCE_MESSAGE))
    ) {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

function redactSentrySpan(span: SentrySpan): SentrySpan {
  redactTelemetryAttributes(span.data);
  if (span.description) span.description = redactTelemetryUrl(span.description);
  return span;
}

function redactSentryEvent<T extends Sentry.Event>(event: T): T {
  if (event.request?.url) event.request.url = redactTelemetryUrl(event.request.url);
  const query = event.request?.query_string;
  if (event.request && query !== undefined) {
    if (typeof query === "string") event.request.query_string = redactTelemetryQuery(query);
    else {
      const params = new URLSearchParams(query);
      const redacted = new URLSearchParams(redactTelemetryQuery(params.toString()));
      event.request.query_string = Array.isArray(query)
        ? [...redacted.entries()]
        : Object.fromEntries(redacted);
    }
  }
  if (event.transaction) event.transaction = redactTelemetryUrl(event.transaction);
  redactTelemetryAttributes(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) redactSentrySpan(span);
  for (const breadcrumb of event.breadcrumbs ?? []) redactTelemetryAttributes(breadcrumb.data);
  return event;
}

export function initProductionSentry(dsn: string | undefined): void {
  if (initialized || !dsn || !isProductionDeployment(process.env.DEPLOY_ENVIRONMENT)) {
    return;
  }

  initProductionPostHog("dofek-worker");

  Sentry.init({
    beforeSend: (event, hint) =>
      isExpectedAccountErasureFence(hint.originalException) ? null : redactSentryEvent(event),
    beforeSendSpan: redactSentrySpan,
    beforeSendTransaction: redactSentryEvent,
    dsn,
    environment: SENTRY_ENVIRONMENT,
    release: process.env.SENTRY_RELEASE,
    skipOpenTelemetrySetup: true,
  });
  initialized = true;
}
