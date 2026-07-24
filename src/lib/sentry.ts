import * as Sentry from "@sentry/node";

const SENTRY_ENVIRONMENT = "production";

function isProductionDeployment(environment: string | undefined): boolean {
  return environment === "prod" || environment === "production";
}

export function initProductionSentry(dsn: string | undefined): void {
  if (!dsn || !isProductionDeployment(process.env.DEPLOY_ENVIRONMENT)) {
    return;
  }

  Sentry.init({
    dsn,
    environment: SENTRY_ENVIRONMENT,
    skipOpenTelemetrySetup: true,
  });
}
