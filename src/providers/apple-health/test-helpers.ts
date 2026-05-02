import type { HealthRecord } from "./records.ts";

export function healthRecord(
  type: string,
  value: number,
  startDate: Date,
  unit: string,
  sourceName = "Apple Watch",
): HealthRecord {
  return {
    type,
    sourceName,
    unit,
    value,
    startDateCalendarDay: startDate.toISOString().slice(0, 10),
    startDate,
    endDate: startDate,
    creationDate: startDate,
  };
}
