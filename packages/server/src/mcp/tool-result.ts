export function jsonToolResult<T>(value: T) {
  const text = serializeJsonText(value);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { result: JSON.parse(text) },
  };
}

export function jsonToolError(code: string, message: string, details?: Record<string, unknown>) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return {
    content: [{ type: "text" as const, text: serializeJsonText({ error }) }],
    isError: true,
  };
}

/** Canonical text serialization for MCP JSON results. */
export function serializeJsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new Error("MCP tool result must be JSON-serializable");
  return text;
}
