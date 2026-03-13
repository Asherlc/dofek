import { randomUUID } from "node:crypto";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";

/** How long pending items are kept before automatic cleanup (30 minutes). */
const PENDING_TTL_MS = 30 * 60 * 1000;

interface PendingEntry {
  items: NutritionItemWithMeal[];
  expiresAt: number;
}

const store = new Map<string, PendingEntry>();

/** Store nutrition items and return a short key for embedding in Slack button values. */
export function storePendingItems(items: NutritionItemWithMeal[]): string {
  // Clean up expired entries on each write
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) store.delete(key);
  }

  const key = randomUUID();
  store.set(key, { items, expiresAt: now + PENDING_TTL_MS });
  return key;
}

/** Retrieve nutrition items by key. Returns null if not found or expired. */
export function retrievePendingItems(key: string): NutritionItemWithMeal[] | null {
  const entry = store.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    if (entry) store.delete(key);
    return null;
  }
  return entry.items;
}

/** Remove a pending entry after it has been consumed. */
export function removePendingItems(key: string): void {
  store.delete(key);
}
