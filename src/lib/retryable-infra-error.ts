const RETRYABLE_INFRA_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "57P03",
  "08000",
  "08003",
  "08006",
]);

const RETRYABLE_INFRA_ERROR_MESSAGES = [
  "the database system is in recovery mode",
  "the database system is not yet accepting connections",
  "connection terminated unexpectedly",
  "connection refused",
  "connection timed out",
  "terminating connection due to administrator command",
  "maxretriesperrequest",
  "redis connection",
] as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function errorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) return undefined;
  return error.cause;
}

export function isRetryableInfraError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);

    const code = errorCode(current);
    if (code && RETRYABLE_INFRA_ERROR_CODES.has(code)) return true;

    const message = errorMessage(current).toLowerCase();
    if (RETRYABLE_INFRA_ERROR_MESSAGES.some((pattern) => message.includes(pattern))) {
      return true;
    }

    current = errorCause(current);
  }

  return false;
}
