/**
 * Sanitize error messages for display to authenticated users.
 *
 * Redacts credential-like substrings (tokens, secrets, auth headers, URL query params)
 * while preserving the diagnostic structure of the message.
 */
export function sanitizeErrorMessage(errorMessage: string | null): string | null {
  if (!errorMessage) return null;

  let sanitized = errorMessage;

  // Redact Authorization header values (must run before generic key/value redaction)
  sanitized = sanitized.replace(
    /\b(authorization\s*:\s*)(bearer|basic)\s+[^\s,]+/gi,
    (_match, prefix: string, scheme: string) => `${prefix}${scheme} [REDACTED]`,
  );

  // Redact common credential key/value pairs in free-form error messages.
  // Only match compound token forms (access_token, refresh_token) — standalone
  // "token" is too generic and matches false positives like "token expired".
  sanitized = sanitized.replace(
    /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|apikey|password|passwd)\b(\s*[:=]\s*|\s+)(["']?)([^\s,"'&]+)/gi,
    (_match, key: string, separator: string, quote: string) =>
      `${key}${separator}${quote}[REDACTED]`,
  );

  // Strip query strings from URLs (often contain tokens/codes)
  sanitized = sanitized.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    const queryIndex = url.indexOf("?");
    return queryIndex >= 0 ? `${url.slice(0, queryIndex)}?[REDACTED]` : url;
  });

  return sanitized;
}
