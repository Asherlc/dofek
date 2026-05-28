import { and, eq } from "drizzle-orm";
import { sleepSession, sleepStage } from "../../db/schema.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { logger } from "../../logger.ts";
import {
  extractSleepIdsFromCycle,
  inlineSleepSchema,
  parseInlineSleep,
  parseSleepStages,
} from "./parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export async function syncWhoopSleepSessions(context: WhoopSyncContext): Promise<number> {
  const { db, cycles, providerId, options } = context;

  try {
    return await withSyncLog(
      db,
      providerId,
      "sleep",
      async () => {
        let count = 0;
        for (const cycle of cycles) {
          const inlineSleeps = cycle.sleeps ?? [];
          let sleepIndex = 0;
          for (const rawSleep of inlineSleeps) {
            const parseResult = inlineSleepSchema.safeParse(rawSleep);
            if (!parseResult.success) {
              logger.warn(
                `[whoop] Skipping inline sleep: schema mismatch: ${parseResult.error.issues[0]?.message}`,
              );
              continue;
            }
            const parsed = parseInlineSleep(parseResult.data, sleepIndex);
            sleepIndex++;
            if (!parsed) {
              logger.warn("[whoop] Skipping inline sleep: invalid timestamps");
              continue;
            }
            if (parseResult.data.state !== "complete") continue;

            try {
              await db
                .insert(sleepSession)
                .values({
                  providerId,
                  externalId: parsed.externalId,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  durationMinutes: parsed.durationMinutes,
                  deepMinutes: parsed.deepMinutes,
                  remMinutes: parsed.remMinutes,
                  lightMinutes: parsed.lightMinutes,
                  awakeMinutes: parsed.awakeMinutes,
                  efficiencyPct: parsed.efficiencyPct,
                  sleepType: parsed.sleepType,
                  sleepNeedBaselineMinutes: parsed.sleepNeedBaselineMinutes,
                  sleepNeedFromDebtMinutes: parsed.sleepNeedFromDebtMinutes,
                  sleepNeedFromStrainMinutes: parsed.sleepNeedFromStrainMinutes,
                  sleepNeedFromNapMinutes: parsed.sleepNeedFromNapMinutes,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                  set: {
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    durationMinutes: parsed.durationMinutes,
                    deepMinutes: parsed.deepMinutes,
                    remMinutes: parsed.remMinutes,
                    lightMinutes: parsed.lightMinutes,
                    awakeMinutes: parsed.awakeMinutes,
                    efficiencyPct: parsed.efficiencyPct,
                    sleepType: parsed.sleepType,
                    sleepNeedBaselineMinutes: parsed.sleepNeedBaselineMinutes,
                    sleepNeedFromDebtMinutes: parsed.sleepNeedFromDebtMinutes,
                    sleepNeedFromStrainMinutes: parsed.sleepNeedFromStrainMinutes,
                    sleepNeedFromNapMinutes: parsed.sleepNeedFromNapMinutes,
                  },
                });
              count++;
            } catch (err) {
              context.errors.push({
                message: `Inline sleep: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }
          }
        }
        return { recordCount: count, result: count };
      },
      options?.userId,
    );
  } catch (err) {
    context.errors.push({
      message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncWhoopSleepStages(context: WhoopSyncContext): Promise<number> {
  const { db, client, cycles, providerId, options } = context;

  try {
    return await withSyncLog(
      db,
      providerId,
      "sleep_stages",
      async () => {
        let count = 0;
        const sleepIds = new Set<string>();
        for (const cycle of cycles) {
          const ids = extractSleepIdsFromCycle(cycle);
          for (const id of ids) sleepIds.add(id);
        }

        for (const sleepId of sleepIds) {
          try {
            const record = await client.getSleep(sleepId);
            if (!record.stages || record.stages.length === 0) continue;

            const stages = parseSleepStages(record);
            if (stages.length === 0) continue;

            const sessionRows = await db
              .select({ id: sleepSession.id })
              .from(sleepSession)
              .where(
                and(eq(sleepSession.providerId, providerId), eq(sleepSession.externalId, sleepId)),
              )
              .limit(1);

            const sessionId = sessionRows[0]?.id;
            if (!sessionId) continue;

            await db.delete(sleepStage).where(eq(sleepStage.sessionId, sessionId));
            await db.insert(sleepStage).values(
              stages.map((stage) => ({
                sessionId,
                stage: stage.stage,
                startedAt: stage.startedAt,
                endedAt: stage.endedAt,
              })),
            );
            count++;
          } catch (err) {
            logger.warn(`[whoop] Failed to fetch sleep stages for ${sleepId}: ${err}`);
          }
        }
        return { recordCount: count, result: count };
      },
      options?.userId,
    );
  } catch (err) {
    context.errors.push({
      message: `sleep_stages: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}
