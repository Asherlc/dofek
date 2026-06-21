import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { WhoopRateLimitError } from "whoop-whoop/client";

export function isWhoopRateLimitError(err: unknown): boolean {
  return (
    err instanceof WhoopRateLimitError ||
    (err instanceof ProviderRateLimitError && err.providerId === "whoop")
  );
}

export function findWhoopRateLimitError(
  errors: Array<{ cause?: unknown }>,
): ProviderRateLimitError | null {
  for (const syncError of errors) {
    const cause = syncError.cause;
    if (isWhoopRateLimitError(cause) && cause instanceof ProviderRateLimitError) {
      return cause;
    }
  }
  return null;
}
