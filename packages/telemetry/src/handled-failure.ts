type HandledFailure = "offline" | "cancelled" | "invalid_credentials";

/** Classify handled outcomes only; unknown failures remain reportable. */
export function classifyHandledFailure(error: unknown): HandledFailure | null {
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SyntaxError) return null;
    if (
      "data" in current &&
      typeof current.data === "object" &&
      current.data !== null &&
      "handledFailure" in current.data &&
      current.data.handledFailure === "invalid_credentials"
    ) {
      return "invalid_credentials";
    }
    if (current instanceof Error) {
      if (
        current.name === "AbortError" ||
        /^(?:fetch failed:\s*cancel(?:led|ed)|The operation was aborted\.)$/i.test(current.message)
      ) {
        return "cancelled";
      }
      if (
        /^fetch failed:\s*(?:UnexpectedException:\s*)?The Internet connection appears to be offline\.(?: \(at [^)]+\))?$/i.test(
          current.message,
        )
      ) {
        return "offline";
      }
      current = current.cause;
    } else {
      return null;
    }
  }
  return null;
}
