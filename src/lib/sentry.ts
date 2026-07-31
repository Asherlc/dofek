import * as Sentry from "@sentry/node";
import { initProductionPostHog } from "./posthog.ts";

const SENTRY_ENVIRONMENT = "production";
let initialized = false;

function isProductionDeployment(environment: string | undefined): boolean {
  return environment === "prod" || environment === "production";
}

export function initProductionSentry(dsn: string | undefined): void {
  if (initialized || !dsn || !isProductionDeployment(process.env.DEPLOY_ENVIRONMENT)) {
    return;
  }

  initProductionPostHog("dofek-worker");

  Sentry.init({
    dsn,
    environment: SENTRY_ENVIRONMENT,
    release: process.env.SENTRY_RELEASE,
    skipOpenTelemetrySetup: true,
  });
  initialized = true;
}
