import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { authFailureReasonFromError } from "../providers/auth-errors.ts";
import { findProviderTransportError } from "./provider-transport-error.ts";

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
  if (error instanceof ProviderRateLimitError || error instanceof ProviderStreamAbortedError)
    return false;
  return !findProviderTransportError(error) && !authFailureReasonFromError(error);
}
