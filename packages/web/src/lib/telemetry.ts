import * as Sentry from "@sentry/react";

declare const __COMMIT_HASH__: string;

const SENTRY_DSN: string | undefined = import.meta.env.VITE_SENTRY_DSN;
const TRACE_PROPAGATION_TARGETS = [/^\/api/, /^\/auth/, /^\/callback/];

let initialized = false;

export function initTelemetry() {
  if (initialized) {
    return;
  }
  initialized = true;

  if (!SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    release: __COMMIT_HASH__,
    integrations: [Sentry.browserTracingIntegration()],
    tracePropagationTargets: TRACE_PROPAGATION_TARGETS,
  });
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  Sentry.captureException(error, { extra: context });
}
