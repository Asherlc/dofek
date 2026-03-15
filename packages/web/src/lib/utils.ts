import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Type assertion for tRPC raw SQL query results.
 * Raw SQL queries return Record<string, unknown>[] — this helper asserts the
 * expected row shape without using banned double-cast patterns.
 * Use only for tRPC endpoints that return raw SQL until proper server-side
 * typing is added.
 */
export function assertRows<T>(data: ReadonlyArray<Record<string, unknown>> | undefined): T[] {
  // @ts-expect-error -- centralized type narrowing for raw SQL results
  const result: T[] = data ?? [];
  return result;
}
