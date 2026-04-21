import { captureException, initTelemetry } from "dofek/telemetry";
import type express from "express";

let initialized = false;

/** @internal - For testing only */
export function __resetTelemetryErrorReportingInitialized() {
  initialized = false;
}

/**
 * Initialize telemetry error capture for the server.
 * Uses `skipOpenTelemetrySetup` to avoid conflicting with the existing
 * OTel→Axiom pipeline in `src/instrumentation.ts`.
 */
export function initTelemetryErrorReporting() {
  if (initialized) {
    return;
  }
  initialized = true;
  initTelemetry();
}

/**
 * Express error-handling middleware that reports errors to telemetry
 * and returns a generic 500 response.
 */
export function telemetryErrorHandler(): express.ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    captureException(err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  };
}
