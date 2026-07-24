import * as Sentry from "@sentry/node";
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

  initProductionSentry(process.env.SENTRY_DSN);
}

/**
 * Express error-handling middleware that reports errors to Sentry
 * and returns a generic 500 response.
 */
export function sentryErrorHandler(): express.ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    Sentry.captureException(err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  };
}
