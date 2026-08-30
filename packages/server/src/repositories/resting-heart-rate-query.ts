import type { SQL } from "drizzle-orm";
import {
  fetchRestingHeartRateRowsFromClickHouse,
  type RestingHeartRateQueryStore,
  type RestingHeartRateRow,
  representativeRestingHeartRate,
  restingHeartRateClickHouseCte,
  restingHeartRateValuesCte,
} from "../../../../src/db/resting-heart-rate-query.ts";

export type { RestingHeartRateRow };
export { representativeRestingHeartRate, restingHeartRateClickHouseCte, restingHeartRateValuesCte };

interface FetchRestingHeartRateRowsInput {
  sensorStore: RestingHeartRateQueryStore;
  userId: string;
  timezone: string;
  endDate: string;
  days: number | null;
}

export async function fetchRestingHeartRateRows({
  sensorStore,
  userId,
  timezone,
  endDate,
  days,
}: FetchRestingHeartRateRowsInput): Promise<RestingHeartRateRow[]> {
  return fetchRestingHeartRateRowsFromClickHouse({
    queryStore: sensorStore,
    userId,
    timezone,
    endDate,
    days,
  });
}

export async function fetchRestingHeartRateValuesCte(
  input: FetchRestingHeartRateRowsInput,
): Promise<SQL> {
  return restingHeartRateValuesCte(await fetchRestingHeartRateRows(input));
}

export function localDateString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}
