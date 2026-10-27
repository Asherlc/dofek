type HandledFailure = "offline" | "cancelled" | "invalid_credentials";

/** Classify handled outcomes only; unknown failures remain reportable. */
export function classifyHandledFailure(error: unknown): HandledFailure | null {
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SyntaxError || (current instanceof Error && current.name === "ZodError"))
      return null;
    let kind: HandledFailure | null = null;
    if (
      "data" in current &&
      typeof current.data === "object" &&
      current.data !== null &&
      "handledFailure" in current.data &&
      current.data.handledFailure === "invalid_credentials"
    ) {
      kind ??= "invalid_credentials";
    }
    if (current instanceof Error) {
      if (
        current.name === "AbortError" ||
        /^(?:fetch failed:\s*cancel(?:led|ed)|The operation was aborted\.)$/i.test(current.message)
      ) {
        kind ??= "cancelled";
      }
      if (
        /^fetch failed:\s*(?:UnexpectedException:\s*)?The Internet connection appears to be offline\.(?: \(at [^)]+\))?$/i.test(
          current.message,
        )
      ) {
        kind ??= "offline";
      }
      if (current.cause === undefined) return kind;
      current = current.cause;
    } else {
      return kind;
    }
  }
  return null;
}
