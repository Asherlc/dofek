import * as Sentry from "@sentry/react-native";

const SENTRY_DSN: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN;

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
  });
}

export function captureException(error: unknown, context: Record<string, unknown> = {}) {
  Sentry.captureException(error, { extra: context });
}
