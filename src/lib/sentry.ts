import * as Sentry from "@sentry/node";
import { initProductionPostHog } from "./posthog.ts";

const SENTRY_ENVIRONMENT = "production";
const ACCOUNT_ERASURE_DATABASE_FENCE_CODE = "55000";
const ACCOUNT_ERASURE_DATABASE_FENCE_MESSAGE = "Account erasure is active for user";
const ACCOUNT_ERASURE_FENCE_ERROR_NAMES = new Set([
  "AccountErasureIdentityFencedError",
  "AccountErasureUserFencedError",
]);
let initialized = false;

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

export function initProductionSentry(dsn: string | undefined): void {
  if (initialized || !dsn || !isProductionDeployment(process.env.DEPLOY_ENVIRONMENT)) {
    return;
  }

  initProductionPostHog("dofek-worker");

  Sentry.init({
    beforeSend: (event, hint) =>
      isExpectedAccountErasureFence(hint.originalException) ? null : event,
    dsn,
    environment: SENTRY_ENVIRONMENT,
    release: process.env.SENTRY_RELEASE,
    skipOpenTelemetrySetup: true,
  });
  initialized = true;
}
