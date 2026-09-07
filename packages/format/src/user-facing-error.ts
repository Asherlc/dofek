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

  if (
    /^unexpected\b|Zod parse failed|ZodError|invalid_(?:type|format|value)|Invalid input:\s*expected|Cannot read properties|is not a function|Unexpected token|JSON\.parse|\b(?:TypeError|ReferenceError|SyntaxError|DrizzleQueryError|PostgresError|ClickHouseError):|Failed query:|\bSELECT\b[\s\S]+\bFROM\b|\bparams:|\n\s*at\s|^\s*[[{][\s\S]*[\]}]\s*$/i.test(
      message,
    )
  ) {
    return fallback;
  }

  return message;
}
