import {
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";

/** Keep token-validation failures actionable without exposing upstream response content. */
export function redactProviderServiceUnavailableError(error: unknown, message: string): unknown {
  if (!(error instanceof ProviderServiceUnavailableError)) return error;
  return new ProviderServiceUnavailableError({
    providerId: error.providerId,
    statusCode: error.statusCode,
    message: `${message} (${error.statusCode}). Try again.`,
    responseBody: "",
    scope: error.scope,
    userId: error.userId,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

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

/** An aggregate can be treated as a timeout only when every failure is a timeout. */
export function isProviderTimeoutOnly(error: unknown): boolean {
  const ancestors = new Set<Error>();

  function check(failure: unknown): boolean {
    if (failure instanceof ProviderRequestTimeoutError) return true;
    if (!(failure instanceof Error) || ancestors.has(failure)) return false;

    ancestors.add(failure);
    const timeoutOnly =
      failure instanceof AggregateError
        ? failure.errors.length > 0 &&
          failure.errors.every(check) &&
          (failure.cause === undefined || check(failure.cause))
        : check(failure.cause);
    ancestors.delete(failure);
    return timeoutOnly;
  }

  return check(error);
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

/** Uses the same one-based attempt convention as the OpenBeta retry predicate. */
export function isRetryingZeppHttp500ServiceUnavailableError(
  error: unknown,
  attemptNumber: number,
  attempts = 1,
): boolean {
  return isZeppHttp500ServiceUnavailableError(error) && attemptNumber < attempts;
}
