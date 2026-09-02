import { serializeJsonText } from "./tool-result.ts";

export function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: serializeJsonText(value) }] };
}

export function assertDateRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error("start_date must be on or before end_date");
  }
}
