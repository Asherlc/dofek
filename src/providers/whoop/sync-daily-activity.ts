import { dailyMetrics } from "../../db/schema/activity.ts";
import { parseStrainDeepDiveSteps } from "./parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export async function syncWhoopStrainDeepDiveForDate(
  context: WhoopSyncContext,
  date: string,
): Promise<number> {
  const { db, client, providerId } = context;
  const raw = await client.getStrainDeepDive(date);
  const steps = parseStrainDeepDiveSteps(raw);
  if (steps == null) return 0;

  await db
    .insert(dailyMetrics)
    .values({ date, providerId, steps })
    .onConflictDoUpdate({
      target: [
        dailyMetrics.userId,
        dailyMetrics.date,
        dailyMetrics.providerId,
        dailyMetrics.sourceName,
      ],
      set: { steps },
    });
  return 1;
}
