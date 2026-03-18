import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "./index.ts";

/**
 * Per-category priority values. Lower number = higher priority.
 * Categories without a value fall back to `activity` (generic), then to 100.
 */
const priorityCategoriesSchema = z.object({
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

type PriorityCategories = z.infer<typeof priorityCategoriesSchema>;

/**
 * Device-level priority override within a provider.
 * Keys are source_name patterns (matched with SQL LIKE), values are category overrides.
 * Only specified categories override the provider default; others fall through.
 */
const devicePrioritySchema = z.record(z.string(), priorityCategoriesSchema.partial());

/**
 * Per-provider priority entry with optional device overrides.
 */
const providerPriorityEntrySchema = priorityCategoriesSchema.extend({
  /** Device-specific priority overrides keyed by source_name pattern (SQL LIKE). */
  devices: devicePrioritySchema.optional(),
});

type ProviderPriorityEntry = z.infer<typeof providerPriorityEntrySchema>;

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
    if (err != null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Upsert provider priorities and device overrides from config into the DB,
 * then delete any rows not present in the config. The JSON file is the
 * single source of truth — the DB is made to match on every sync.
 */
export async function syncProviderPriorities(
  db: SyncDatabase,
  config: ProviderPriorityConfig,
): Promise<void> {
  const configProviderIds: string[] = [];
  const configDevicePatterns: Array<{ providerId: string; pattern: string }> = [];

  // Collect all values for batched upserts
  const providerValues: Array<{
    id: string;
    entry: ProviderPriorityEntry;
  }> = [];
  const deviceValues: Array<{
    providerId: string;
    pattern: string;
    overrides: Partial<PriorityCategories>;
  }> = [];

  for (const [providerId, entry] of Object.entries(config.providers)) {
    configProviderIds.push(providerId);
    providerValues.push({ id: providerId, entry });

    if (entry.devices) {
      for (const [pattern, overrides] of Object.entries(entry.devices)) {
        configDevicePatterns.push({ providerId, pattern });
        deviceValues.push({ providerId, pattern, overrides });
      }
    }
  }

  // Batch upsert provider priorities
  if (providerValues.length > 0) {
    const valueFragments = providerValues.map(
      ({ id, entry }) =>
        sql`(${id}, ${entry.activity}, ${entry.sleep ?? null}, ${entry.body ?? null}, ${entry.recovery ?? null}, ${entry.dailyActivity ?? null})`,
    );
    await db.execute(
      sql`INSERT INTO fitness.provider_priority
            (provider_id, priority, sleep_priority, body_priority, recovery_priority, daily_activity_priority)
          VALUES ${sql.join(valueFragments, sql`, `)}
          ON CONFLICT (provider_id) DO UPDATE SET
            priority = EXCLUDED.priority,
            sleep_priority = EXCLUDED.sleep_priority,
            body_priority = EXCLUDED.body_priority,
            recovery_priority = EXCLUDED.recovery_priority,
            daily_activity_priority = EXCLUDED.daily_activity_priority`,
    );
  }

  // Batch upsert device priorities
  if (deviceValues.length > 0) {
    const deviceFragments = deviceValues.map(
      ({ providerId, pattern, overrides }) =>
        sql`(${providerId}, ${pattern}, ${overrides.activity ?? null}, ${overrides.sleep ?? null}, ${overrides.body ?? null}, ${overrides.recovery ?? null}, ${overrides.dailyActivity ?? null})`,
    );
    await db.execute(
      sql`INSERT INTO fitness.device_priority
            (provider_id, source_name_pattern, priority, sleep_priority, body_priority, recovery_priority, daily_activity_priority)
          VALUES ${sql.join(deviceFragments, sql`, `)}
          ON CONFLICT (provider_id, source_name_pattern) DO UPDATE SET
            priority = EXCLUDED.priority,
            sleep_priority = EXCLUDED.sleep_priority,
            body_priority = EXCLUDED.body_priority,
            recovery_priority = EXCLUDED.recovery_priority,
            daily_activity_priority = EXCLUDED.daily_activity_priority`,
    );
  }

  // Delete device priorities not in the config
  if (configDevicePatterns.length === 0) {
    await db.execute(sql`DELETE FROM fitness.device_priority`);
  } else {
    const keepConditions = configDevicePatterns.map(
      ({ providerId, pattern }) =>
        sql`(provider_id = ${providerId} AND source_name_pattern = ${pattern})`,
    );
    await db.execute(
      sql`DELETE FROM fitness.device_priority WHERE NOT (${sql.join(keepConditions, sql` OR `)})`,
    );
  }

  // Delete provider priorities not in the config
  if (configProviderIds.length === 0) {
    await db.execute(sql`DELETE FROM fitness.provider_priority`);
  } else {
    await db.execute(
      sql`DELETE FROM fitness.provider_priority WHERE provider_id NOT IN (${sql.join(
        configProviderIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
}
