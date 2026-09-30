import {
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";

export function findProviderTransportError(
  error: unknown,
): ProviderServiceUnavailableError | ProviderRequestTimeoutError | null {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (
      current instanceof ProviderServiceUnavailableError ||
      current instanceof ProviderRequestTimeoutError
    ) {
      return current;
    }
    visited.add(current);
    current = current.cause;
  }
  return null;
}

export function isZeppHttp500ServiceUnavailableError(
  error: unknown,
): error is ProviderServiceUnavailableError {
  return (
    error instanceof ProviderServiceUnavailableError &&
    error.providerId === "amazfit-zepp" &&
    error.statusCode === 500
  );
}

/** attemptNumber is one-based: the processor adds one; a failed event is already incremented. */
export function isRetryingOpenBetaTransportFailure(
  error: unknown,
  attemptNumber: number,
  attempts = 1,
): boolean {
  return findProviderTransportError(error)?.providerId === "openbeta" && attemptNumber < attempts;
}
