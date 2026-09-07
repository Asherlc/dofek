const DEFAULT_ERROR_MESSAGE = "We couldn't complete this request. Please try again.";
const CONNECTION_ERROR_MESSAGE =
  "We couldn't reach the server. Check your connection and try again.";
const TIMEOUT_ERROR_MESSAGE = "The request took too long. Please try again.";

function errorText(error: unknown): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : null;
  const trimmed = message?.trim();
  return trimmed ? trimmed : null;
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function isTechnicalDiagnostic(message: string): boolean {
  const normalized = message.toLowerCase();
  const trimmed = message.trim();
  const isSerializedValue =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  const hasStackFrame = message
    .split("\n")
    .some((line) => line.trimStart().toLowerCase().startsWith("at "));
  const containsSqlQuery = normalized.includes("select ") && normalized.includes(" from ");

  return (
    normalized.startsWith("unexpected") ||
    includesAny(message, [
      "ZodError",
      "TypeError:",
      "ReferenceError:",
      "SyntaxError:",
      "DrizzleQueryError:",
      "PostgresError:",
      "ClickHouseError:",
    ]) ||
    includesAny(normalized, [
      "zod parse failed",
      "invalid_type",
      "invalid_format",
      "invalid_value",
      "invalid input: expected",
      "cannot read properties",
      "is not a function",
      "unexpected token",
      "json.parse",
      "failed query:",
      "params:",
    ]) ||
    hasStackFrame ||
    containsSqlQuery ||
    isSerializedValue
  );
}

/**
 * Returns text that is safe to present directly to a person. Specific messages
 * authored for users pass through; browser, network, validation, and runtime
 * diagnostics are replaced with a useful explanation.
 */
export function userFacingErrorMessage(error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  const message = errorText(error);
  if (!message) return fallback;

  if (/^(?:UNAUTHORIZED|Not authenticated)$/i.test(message)) {
    return "Your session has expired. Sign in and try again.";
  }

  if (/^(?:FORBIDDEN|Admin access required)$/i.test(message)) {
    return "You don't have permission to do that.";
  }

  if (
    /failed to fetch|\bfetch failed\b|network request failed|network connection was lost|^load failed$|^connection (?:reset|refused|lost)/i.test(
      message,
    ) ||
    /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)\b/i.test(message)
  ) {
    return CONNECTION_ERROR_MESSAGE;
  }

  if (/\bETIMEDOUT\b|request (?:timed out|timeout)|timeout exceeded/i.test(message)) {
    return TIMEOUT_ERROR_MESSAGE;
  }

  if (isTechnicalDiagnostic(message)) {
    return fallback;
  }

  return message;
}
