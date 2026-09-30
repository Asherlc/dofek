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
