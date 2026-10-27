import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";

export function isWhoopRateLimitError(err: unknown): err is ProviderRateLimitError {
  return err instanceof ProviderRateLimitError && err.providerId === "whoop";
}

export function findWhoopRateLimitError(
  errors: Array<{ cause?: unknown }>,
): ProviderRateLimitError | null {
  for (const syncError of errors) {
    const cause = syncError.cause;
    if (isWhoopRateLimitError(cause)) {
      return cause;
    }
  }
  return null;
}
