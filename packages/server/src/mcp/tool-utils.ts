import { jsonToolResult } from "./tool-result.ts";

export function jsonContent(value: unknown) {
  return jsonToolResult(value);
}

export function assertDateRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error("start_date must be on or before end_date");
  }
}
