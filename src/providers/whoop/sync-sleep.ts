import { and, eq, isNotNull } from "drizzle-orm";
import { dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { logger } from "../../logger.ts";
import { resolveWhoopCycleDay } from "./cycle-day.ts";
import {
  extractSleepIdsFromCycle,
  inlineSleepSchema,
  parseInlineSleep,
  parseSleepStages,
  resolveInlineSleepExternalId,
} from "./parsing.ts";
import { isWhoopRateLimitError } from "./rate-limit.ts";
import type { WhoopPersistenceContext, WhoopSyncContext } from "./sync-types.ts";

export type WhoopSleepStagesSyncResult = {
  count: number;
  rateLimited: boolean;
};

export async function syncWhoopSleepSessions(context: WhoopPersistenceContext): Promise<number> {
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
            const externalId = resolveInlineSleepExternalId(cycle, parseResult.data, sleepIndex);
            const parsed = parseInlineSleep(parseResult.data, sleepIndex, externalId);
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
                  stagingAvailable: parsed.stagingAvailable,
                  efficiencyPct: parsed.efficiencyPct,
                  sleepType: parsed.sleepType,
                  isNap: parsed.isNap,
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
                    stagingAvailable: parsed.stagingAvailable,
                    efficiencyPct: parsed.efficiencyPct,
                    sleepType: parsed.sleepType,
                    isNap: parsed.isNap,
                    sleepNeedBaselineMinutes: parsed.sleepNeedBaselineMinutes,
                    sleepNeedFromDebtMinutes: parsed.sleepNeedFromDebtMinutes,
                    sleepNeedFromStrainMinutes: parsed.sleepNeedFromStrainMinutes,
                    sleepNeedFromNapMinutes: parsed.sleepNeedFromNapMinutes,
                  },
                });
              if (!parsed.isNap && parsed.respiratoryRateAvg != null) {
                const metricDate = resolveWhoopCycleDay(cycle, parsed.endedAt);
                await db
                  .insert(dailyMetrics)
                  .values({
                    date: metricDate,
                    providerId,
                    respiratoryRateAvg: parsed.respiratoryRateAvg,
                  })
                  .onConflictDoUpdate({
                    target: [
                      dailyMetrics.userId,
                      dailyMetrics.date,
                      dailyMetrics.providerId,
                      dailyMetrics.sourceName,
                    ],
                    set: {
                      respiratoryRateAvg: parsed.respiratoryRateAvg,
                    },
                  });
              }
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

export async function syncWhoopSleepStagesForId(
  context: WhoopSyncContext,
  sleepId: string,
): Promise<number> {
  const { db, client, providerId, options } = context;
  const userId = options?.userId ?? getTokenUserId();
  if (!userId) return 0;

  const record = await client.getSleep(sleepId);
  if (!record.stages || record.stages.length === 0) return 0;

  const stages = parseSleepStages(record);
  if (stages.length === 0) return 0;

  const sessionRows = await db
    .select({ id: sleepSession.id })
    .from(sleepSession)
    .where(
      and(
        eq(sleepSession.userId, userId),
        eq(sleepSession.providerId, providerId),
        eq(sleepSession.externalId, sleepId),
      ),
    )
    .limit(1);

  const sessionId = sessionRows[0]?.id;
  if (!sessionId) return 0;

  await db.delete(sleepStage).where(eq(sleepStage.sessionId, sessionId));
  await db.insert(sleepStage).values(
    stages.map((stage) => ({
      sessionId,
      stage: stage.stage,
      startedAt: stage.startedAt,
      endedAt: stage.endedAt,
    })),
  );
  return 1;
}

export async function syncWhoopSleepStages(
  context: WhoopSyncContext,
): Promise<WhoopSleepStagesSyncResult> {
  const { db, cycles, providerId, options } = context;

  try {
    const result = await withSyncLog(
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

        const userId = options?.userId ?? getTokenUserId();
        const syncedSleepIds =
          userId == null
            ? new Set<string>()
            : new Set(
                (
                  await db
                    .select({ externalId: sleepSession.externalId })
                    .from(sleepSession)
                    .innerJoin(sleepStage, eq(sleepStage.sessionId, sleepSession.id))
                    .where(
                      and(
                        eq(sleepSession.userId, userId),
                        eq(sleepSession.providerId, providerId),
                        isNotNull(sleepSession.externalId),
                      ),
                    )
                )
                  .map((row) => row.externalId)
                  .filter((externalId): externalId is string => externalId != null),
              );

        for (const sleepId of sleepIds) {
          if (syncedSleepIds.has(sleepId)) continue;

          try {
            count += await syncWhoopSleepStagesForId(context, sleepId);
          } catch (err) {
            if (isWhoopRateLimitError(err)) {
              context.errors.push({
                message: `sleep_stages: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
              return {
                recordCount: count,
                result: { count, rateLimited: true },
              };
            }
            context.errors.push({
              message: `sleep_stages(${sleepId}): ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            });
            logger.warn(`[whoop] Failed to fetch sleep stages for ${sleepId}: ${err}`);
          }
        }
        return { recordCount: count, result: { count, rateLimited: false } };
      },
      options?.userId,
    );
    return result;
  } catch (err) {
    if (isWhoopRateLimitError(err)) {
      context.errors.push({
        message: `sleep_stages: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { count: 0, rateLimited: true };
    }
    context.errors.push({
      message: `sleep_stages: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return { count: 0, rateLimited: false };
  }
}
