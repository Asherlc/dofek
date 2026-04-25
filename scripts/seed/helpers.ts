import type { TaggedQueryClient } from "../../src/db/tagged-query-client.ts";

export type Sql = TaggedQueryClient;

export const USER_ID = "00000000-0000-0000-0000-000000000001";

export const SEED_PROVIDER_IDS = [
  "whoop",
  "apple_health",
  "strava",
  "bodyspec",
  "manual_review",
] as const;

export const SEED_PROVIDER_NAMES: Record<(typeof SEED_PROVIDER_IDS)[number], string> = {
  whoop: "WHOOP",
  apple_health: "Apple Health",
  strava: "Strava",
  bodyspec: "BodySpec",
  manual_review: "Manual Review",
};

export class SeedRandom {
  #state: number;

  constructor(seed: number) {
    this.#state = seed;
  }

  next(): number {
    this.#state = (1664525 * this.#state + 1013904223) >>> 0;
    return this.#state / 0x100000000;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min: number, max: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round((this.next() * (max - min) + min) * factor) / factor;
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.int(0, values.length - 1)];
    if (value === undefined) throw new Error("Cannot pick from an empty array");
    return value;
  }
}

export function daysBefore(from: Date, daysAgo: number): string {
  const date = new Date(from);
  date.setDate(date.getDate() - daysAgo);
  return formatDate(date);
}

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localTimestamp(dateStr: string, time: string): string {
  const offsetMin = new Date().getTimezoneOffset();
  const sign = offsetMin <= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const hours = String(Math.floor(absMin / 60)).padStart(2, "0");
  const mins = String(absMin % 60).padStart(2, "0");
  return `${dateStr}T${time}${sign}${hours}:${mins}`;
}

export function timestampAt(dateStr: string, hour: number, minute = 0, second = 0): string {
  return localTimestamp(
    dateStr,
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
  );
}

export function addMinutes(timestamp: string, minutes: number): string {
  return new Date(new Date(timestamp).getTime() + minutes * 60_000).toISOString();
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
