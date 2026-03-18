import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "./index.ts";

/**
 * Per-category priority for a single provider.
 * Lower number = higher priority. Categories without a value
 * fall back to `activity` (generic), then to 100.
 */
const providerPriorityEntrySchema = z.object({
  /** Generic / activity-level priority (used by v_activity). */
  activity: z.number().int().positive(),
  /** Sleep tracking accuracy (used by v_sleep). */
  sleep: z.number().int().positive().optional(),
  /** Body composition accuracy (used by v_body_measurement). */
  body: z.number().int().positive().optional(),
  /** Recovery metric accuracy: resting HR, HRV, SpO2, respiratory rate, skin temp (used by v_daily_metrics). */
  recovery: z.number().int().positive().optional(),
  /** Daily activity metric accuracy: steps, calories, distance, flights (used by v_daily_metrics). */
  dailyActivity: z.number().int().positive().optional(),
});

export type ProviderPriorityEntry = z.infer<typeof providerPriorityEntrySchema>;

export const providerPriorityConfigSchema = z.object({
  providers: z.record(z.string(), providerPriorityEntrySchema),
});

export type ProviderPriorityConfig = z.infer<typeof providerPriorityConfigSchema>;

/**
 * Load and validate provider-priority.json from the project root.
 * Returns null if the file doesn't exist (not an error — config is optional).
 * Throws on malformed JSON or schema violations.
 */
export function loadProviderPriorityConfig(basePath?: string): ProviderPriorityConfig | null {
  const dir = basePath ?? resolve(import.meta.dirname, "../..");
  const filePath = resolve(dir, "provider-priority.json");
  try {
    const raw = readFileSync(filePath, "utf-8");
    return providerPriorityConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof Error && err.message.includes("ENOENT")) {
      return null;
    }
    throw err;
  }
}

/**
 * Upsert provider priorities from config into the provider_priority table.
 * This makes the JSON file the source of truth — DB is updated to match on every sync.
 */
export async function syncProviderPriorities(
  db: SyncDatabase,
  config: ProviderPriorityConfig,
): Promise<void> {
  for (const [providerId, entry] of Object.entries(config.providers)) {
    await db.execute(
      sql`INSERT INTO fitness.provider_priority
            (provider_id, priority, sleep_priority, body_priority, recovery_priority, daily_activity_priority)
          VALUES (
            ${providerId},
            ${entry.activity},
            ${entry.sleep ?? null},
            ${entry.body ?? null},
            ${entry.recovery ?? null},
            ${entry.dailyActivity ?? null}
          )
          ON CONFLICT (provider_id) DO UPDATE SET
            priority = EXCLUDED.priority,
            sleep_priority = EXCLUDED.sleep_priority,
            body_priority = EXCLUDED.body_priority,
            recovery_priority = EXCLUDED.recovery_priority,
            daily_activity_priority = EXCLUDED.daily_activity_priority`,
    );
  }
}
