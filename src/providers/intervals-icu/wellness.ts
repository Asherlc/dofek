import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { dailyMetrics, dailyMetricValue } from "../../db/schema/activity.ts";
import type { SyncRun } from "../sync-run.ts";
import type { SyncError } from "../types.ts";
import type { IntervalsIcuClient } from "./client.ts";
import { intervalsIcuLocalDateWindow } from "./local-date-window.ts";

export interface IntervalsIcuWellnessResult {
  recordsSynced: number;
  errors: SyncError[];
}

const INT32_MAX = 2_147_483_647;
const listSchema = z.array(z.object({ id: z.unknown() }).passthrough());

// Invalid values fail the whole record: malformed data is reported, never mapped to null/zero.
const nonNegativeInt32 = z.number().int().min(0).max(INT32_MAX).nullable().optional();
const positiveInt32 = z.number().int().min(1).max(INT32_MAX).nullable().optional();
const positiveReal = z.number().positive().finite().nullable().optional();
const wellnessSchema = z.object({
  id: z.iso.date(),
  weight: positiveReal,
  restingHR: positiveInt32,
  hrv: positiveReal,
  steps: nonNegativeInt32,
  sleepSecs: nonNegativeInt32,
  spO2: z.number().positive().max(100).nullable().optional(),
  tempWeight: z.boolean().nullable().optional(),
  tempRestingHR: z.boolean().nullable().optional(),
});
type Wellness = z.infer<typeof wellnessSchema>;

/**
 * A flagged value is a settings default, not a measurement: ignore it (preserve what is stored).
 * An explicit null still clears. `undefined` always means "leave the stored fact alone".
 */
const unlessTemporary = (
  value: number | null | undefined,
  temporary: boolean | null | undefined,
) => (value != null && temporary === true ? undefined : value);

function nativeColumns(row: Wellness) {
  return {
    ...(row.hrv !== undefined && { hrv: row.hrv }),
    ...(row.spO2 !== undefined && { spo2Avg: row.spO2 }),
    ...(row.steps !== undefined && { steps: row.steps }),
  };
}

/** Catalog facts: `undefined` preserves the stored fact, `null` clears it. */
function catalogFacts(row: Wellness): Array<[string, number | null]> {
  const facts: Array<[string, number | null | undefined]> = [
    ["weight", unlessTemporary(row.weight, row.tempWeight)],
    ["resting_heart_rate", unlessTemporary(row.restingHR, row.tempRestingHR)],
    ["sleep_duration_reported", row.sleepSecs],
  ];
  return facts.flatMap(([metric, value]) => (value === undefined ? [] : [[metric, value]]));
}

/**
 * Sync date-only wellness for the run window. Each record's `id` is the athlete-local calendar
 * date and is stored unchanged. Explicit null clears a source fact; an omitted field preserves it.
 * Omission never deletes a day, and days with nothing to write never create placeholder rows.
 */
export async function syncIntervalsIcuWellness(
  client: IntervalsIcuClient,
  run: SyncRun,
  providerId: string,
): Promise<IntervalsIcuWellnessResult> {
  const userId = run.options.userId;
  if (!userId) throw new Error("Intervals.icu wellness sync requires a user ID");
  const result: IntervalsIcuWellnessResult = { recordsSynced: 0, errors: [] };
  const { oldest, newest } = intervalsIcuLocalDateWindow(run);
  let list: z.infer<typeof listSchema>;
  try {
    // No `fields` projection: the API drops explicit nulls when it is used.
    list = await client.get("/athlete/0/wellness", listSchema, {
      query: { oldest, newest },
      signal: run.options.signal,
    });
  } catch (error) {
    result.errors.push({
      message: `Wellness: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
    return result;
  }

  for (const raw of list) {
    run.options.signal?.throwIfAborted();
    const parsed = wellnessSchema.safeParse(raw);
    if (!parsed.success) {
      result.errors.push({
        message: "Wellness record does not match the expected shape",
        cause: parsed.error,
      });
      continue;
    }
    const row = parsed.data;
    // Vendor padding must never touch stored facts outside the exact requested range.
    if (row.id < oldest || row.id > newest) continue;

    const native = nativeColumns(row);
    const facts = catalogFacts(row);
    const hasNativeChange = Object.keys(native).length > 0;
    if (!hasNativeChange && facts.length === 0) continue;
    const hasValue =
      Object.values(native).some((value) => value != null) ||
      facts.some(([, value]) => value != null);

    try {
      const wrote = await run.db.transaction(async (transaction) => {
        const key = and(
          eq(dailyMetrics.userId, userId),
          eq(dailyMetrics.date, row.id),
          eq(dailyMetrics.providerId, providerId),
          isNull(dailyMetrics.sourceName),
        );
        let parentId: string | undefined;
        if (hasValue) {
          const [parent] = await transaction
            .insert(dailyMetrics)
            .values({ date: row.id, providerId, userId, sourceName: null, ...native })
            .onConflictDoUpdate({
              target: [
                dailyMetrics.userId,
                dailyMetrics.date,
                dailyMetrics.providerId,
                dailyMetrics.sourceName,
              ],
              set: { date: row.id, ...native },
            })
            .returning({ id: dailyMetrics.id });
          parentId = parent?.id;
        } else {
          // Clear-only record: apply to an existing parent, never create a placeholder.
          const [existing] = await transaction
            .select({ id: dailyMetrics.id })
            .from(dailyMetrics)
            .where(key)
            .limit(1);
          parentId = existing?.id;
          if (parentId && hasNativeChange) {
            await transaction.update(dailyMetrics).set(native).where(key);
          }
        }
        if (!parentId) return false;
        for (const [metricTypeId, value] of facts) {
          if (value === null) {
            await transaction
              .delete(dailyMetricValue)
              .where(
                and(
                  eq(dailyMetricValue.dailyMetricsId, parentId),
                  eq(dailyMetricValue.metricTypeId, metricTypeId),
                ),
              );
          } else {
            await transaction
              .insert(dailyMetricValue)
              .values({ dailyMetricsId: parentId, metricTypeId, value })
              .onConflictDoUpdate({
                target: [dailyMetricValue.dailyMetricsId, dailyMetricValue.metricTypeId],
                set: { value },
              });
          }
        }
        return true;
      });
      if (wrote) result.recordsSynced++;
    } catch (error) {
      result.errors.push({
        message: `Wellness ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  }
  return result;
}
