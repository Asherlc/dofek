import { captureException } from "dofek/lib/error-reporting";
import { initProductionPostHog } from "dofek/lib/posthog";
import { initProductionSentry } from "dofek/lib/sentry";
import type express from "express";

let initialized = false;

/** @internal - For testing only */
export function __resetSentryInitialized() {
  initialized = false;
}

/**
 * Initialize Sentry error capture for the server.
 * Uses `skipOpenTelemetrySetup` to avoid conflicting with the existing
 * OTel→Axiom pipeline in `src/instrumentation.ts`.
 */
export function initSentry() {
  if (initialized) {
    return;
  }
  initialized = true;

  initProductionPostHog("dofek-web-server");
  initProductionSentry(process.env.SENTRY_DSN);
}

/**
 * Express error-handling middleware that reports errors to Sentry
 * and PostHog and returns a generic 500 response.
 */
export function sentryErrorHandler(): express.ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    captureException(err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  };
}
