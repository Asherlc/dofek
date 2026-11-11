import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { authFailureReasonFromError } from "../providers/auth-errors.ts";
import { findProviderTransportError } from "./provider-transport-error.ts";

/** Keep known operational outcomes in sync status, logs and persistence escalation. */
export function shouldReportProviderError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof ProviderRateLimitError) return false;
  return !findProviderTransportError(error) && !authFailureReasonFromError(error);
}
