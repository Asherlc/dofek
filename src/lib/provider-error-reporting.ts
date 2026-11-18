import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { authFailureReasonFromError, ProviderAccessDeniedError } from "../providers/auth-errors.ts";
import { findProviderTransportError } from "./provider-transport-error.ts";
import { isRetryableInfraError } from "./retryable-infra-error.ts";

export function providerSyncFailureKind(error: unknown) {
  if (error instanceof ProviderAccessDeniedError) return "access_denied";
  if (error instanceof ProviderRateLimitError) return "rate_limited";
  if (error instanceof ProviderStreamAbortedError) return "stream_aborted";
  if (authFailureReasonFromError(error)) return "authorization";
  const transport = findProviderTransportError(error);
  if (transport instanceof ProviderRequestTimeoutError) return "timeout";
  if (transport instanceof ProviderServiceUnavailableError) return "service_unavailable";
  if (isRetryableInfraError(error)) return "infrastructure";
  return "unknown";
}

export class ProviderStreamAbortedError extends Error {
  override readonly name = "ProviderStreamAbortedError";
}

/** Only a typed provider HTTP 5xx response is a known server-side outage. */
export function isKnownProviderHttp5xxError(error: unknown): boolean {
  const transportError = findProviderTransportError(error);
  return (
    transportError instanceof ProviderServiceUnavailableError &&
    transportError.statusCode >= 500 &&
    transportError.statusCode <= 599
  );
}

/** Keep known operational outcomes in sync status, logs and persistence escalation. */
export function shouldReportProviderError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderAccessDeniedError ||
    error instanceof ProviderStreamAbortedError
  )
    return false;
  return !findProviderTransportError(error) && !authFailureReasonFromError(error);
}
