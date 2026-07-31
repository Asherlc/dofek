import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

declare const __COMMIT_HASH__: string;

const SENTRY_DSN: string | undefined = import.meta.env.VITE_SENTRY_DSN;
const TRACE_PROPAGATION_TARGETS = [/^\/api/, /^\/auth/, /^\/callback/];

let initialized = false;

export type TelemetryUser = {
  id: string;
  name: string;
  email: string | null;
};

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
  posthog.captureException(error, context);
}

export function identifyUser(user: TelemetryUser): void {
  posthog.identify(user.id, {
    email: user.email,
    name: user.name,
  });
}

export function resetUser(): void {
  posthog.reset();
}
