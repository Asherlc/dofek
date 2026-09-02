export function jsonContent(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) {
    throw new Error("MCP tool result must be JSON-serializable");
  }
  return { content: [{ type: "text" as const, text }] };
}

export function assertDateRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error("start_date must be on or before end_date");
  }
}
