export function jsonToolResult<T>(value: T) {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) {
    throw new TypeError("MCP tool results must be JSON-serializable");
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value,
  };
}
