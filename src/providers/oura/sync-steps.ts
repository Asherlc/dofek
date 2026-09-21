import type { SyncDatabase } from "../../db/index.ts";
import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { dailyMetrics, sleepSession } from "../../db/schema/activity.ts";
import { healthEvent } from "../../db/schema/clinical.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { fetchProviderPages } from "../../sync/pagination.ts";
import type { SyncDegradation } from "../../sync/sync-degradation.ts";
import type { SyncError, SyncOptions } from "../types.ts";
import type { OuraClient } from "./client.ts";
import { formatDate } from "./oauth.ts";
import {
  mapOuraActivityType,
  mapOuraSessionType,
  ouraProviderOffsetColumns,
  parseOuraDailyMetrics,
  parseOuraSleep,
} from "./parsing.ts";
import type {
  OuraDailyActivity,
  OuraDailySpO2,
  OuraHeartRate,
  OuraListResponse,
  OuraSleepDocument,
} from "./schemas.ts";

interface OuraPagesResult<T> {
  items: T[];
  degradations: SyncDegradation[];
}

async function fetchOuraPages<T>(
  providerId: string,
  stepName: string,
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
  onPage?: (items: readonly T[]) => Promise<void> | void,
): Promise<OuraPagesResult<T>> {
  const result = await fetchProviderPages({
    providerId,
    stepName,
    fetchPage: async (cursor) => {
      const response = await fetchPage(cursor);
      return {
        items: response.data,
        nextCursor: response.next_token || null,
      };
    },
    onPage: onPage ? (page) => onPage(page.items) : undefined,
  });

  return { items: result.items, degradations: result.degradations };
}

interface SyncStepContext {
  db: SyncDatabase;
  providerId: string;
  client: OuraClient;
  sinceDate: string;
  todayDate: string;
  errors: SyncError[];
  options?: SyncOptions;
  activityPresentExternalIds?: Set<string>;
}

export async function syncSleep(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const sleepCount = await withSyncLog(
      db,
      providerId,
      "sleep",
      async () => {
        let count = 0;
        const sleepPages = await fetchOuraPages(
          providerId,
          "sleep",
          (nextToken) => client.getSleep(sinceDate, todayDate, nextToken),
          async (items) => {
            for (const raw of items) {
              const parsed = parseOuraSleep(raw);
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
                    timezone: parsed.localTimeContext.timezone,
                    startUtcOffsetMinutes: parsed.localTimeContext.startUtcOffsetMinutes,
                    endUtcOffsetMinutes: parsed.localTimeContext.endUtcOffsetMinutes,
                    localTimeSource: parsed.localTimeContext.source,
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
                      timezone: parsed.localTimeContext.timezone,
                      startUtcOffsetMinutes: parsed.localTimeContext.startUtcOffsetMinutes,
                      endUtcOffsetMinutes: parsed.localTimeContext.endUtcOffsetMinutes,
                      localTimeSource: parsed.localTimeContext.source,
                    },
                  });
                count++;
              } catch (err) {
                errors.push({
                  message: err instanceof Error ? err.message : String(err),
                  externalId: parsed.externalId,
                  cause: err,
                });
              }
            }
          },
        );

        return { recordCount: count, result: count, degradations: sleepPages.degradations };
      },
      options?.userId,
    );
    return sleepCount;
  } catch (err) {
    errors.push({
      message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncWorkouts(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const workoutCount = await withSyncLog(
      db,
      providerId,
      "workouts",
      async () => {
        let count = 0;
        const workoutPages = await fetchOuraPages(
          providerId,
          "workouts",
          (nextToken) => client.getWorkouts(sinceDate, todayDate, nextToken),
          async (items) => {
            for (const workout of items) {
              context.activityPresentExternalIds?.add(workout.id);
              try {
                await upsertProviderActivity(
                  db,
                  {
                    providerId,
                    externalId: workout.id,
                    activityType: mapOuraActivityType(workout.activity),
                    startedAt: new Date(workout.start_datetime),
                    endedAt: new Date(workout.end_datetime),
                    ...ouraProviderOffsetColumns(workout.start_datetime, workout.end_datetime),
                    name: workout.label,
                    raw: workout,
                  },
                  {
                    activityType: mapOuraActivityType(workout.activity),
                    startedAt: new Date(workout.start_datetime),
                    endedAt: new Date(workout.end_datetime),
                    ...ouraProviderOffsetColumns(workout.start_datetime, workout.end_datetime),
                    name: workout.label,
                    raw: workout,
                  },
                );
                count++;
              } catch (err) {
                errors.push({
                  message: `workout ${workout.id}: ${err instanceof Error ? err.message : String(err)}`,
                  externalId: workout.id,
                  cause: err,
                });
              }
            }
          },
        );

        return { recordCount: count, result: count, degradations: workoutPages.degradations };
      },
      options?.userId,
    );
    return workoutCount;
  } catch (err) {
    errors.push({
      message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncSessions(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const sessionCount = await withSyncLog(
      db,
      providerId,
      "sessions",
      async () => {
        let count = 0;
        const sessionPages = await fetchOuraPages(
          providerId,
          "sessions",
          (nextToken) => client.getSessions(sinceDate, todayDate, nextToken),
          async (items) => {
            for (const session of items) {
              context.activityPresentExternalIds?.add(session.id);
              try {
                const sessionActivityType = mapOuraSessionType(session.type);
                await upsertProviderActivity(
                  db,
                  {
                    providerId,
                    externalId: session.id,
                    activityType: sessionActivityType,
                    startedAt: new Date(session.start_datetime),
                    endedAt: new Date(session.end_datetime),
                    ...ouraProviderOffsetColumns(session.start_datetime, session.end_datetime),
                    name: session.type,
                    raw: session,
                  },
                  {
                    activityType: sessionActivityType,
                    startedAt: new Date(session.start_datetime),
                    endedAt: new Date(session.end_datetime),
                    ...ouraProviderOffsetColumns(session.start_datetime, session.end_datetime),
                    name: session.type,
                    raw: session,
                  },
                );
                count++;
              } catch (err) {
                errors.push({
                  message: `session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
                  externalId: session.id,
                  cause: err,
                });
              }
            }
          },
        );

        return { recordCount: count, result: count, degradations: sessionPages.degradations };
      },
      options?.userId,
    );
    return sessionCount;
  } catch (err) {
    errors.push({
      message: `sessions: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncHeartRate(context: SyncStepContext, since: Date): Promise<number> {
  const { db, providerId, client, errors, options } = context;
  // Oura heart rate API enforces a max 30-day window per request
  try {
    const hrCount = await withSyncLog(
      db,
      providerId,
      "heart_rate",
      async () => {
        const allHr: OuraHeartRate[] = [];
        const degradations: SyncDegradation[] = [];
        const windowMs = 30 * 24 * 60 * 60 * 1000;
        let windowStart = since.getTime();
        const end = Date.now();

        while (windowStart < end) {
          const windowEnd = Math.min(windowStart + windowMs, end);
          const startStr = formatDate(new Date(windowStart));
          const endStr = formatDate(new Date(windowEnd));
          if (startStr === endStr) break;
          const chunk = await fetchOuraPages(providerId, "heart_rate", (nextToken) =>
            client.getHeartRate(startStr, endStr, nextToken),
          );
          allHr.push(...chunk.items);
          degradations.push(...chunk.degradations);
          if (chunk.degradations.length > 0) break;
          windowStart = windowEnd;
        }

        const rows = allHr.map((hr) => ({
          providerId,
          recordedAt: new Date(hr.timestamp),
          heartRate: hr.bpm,
        }));

        await writeMetricStreamBatch(
          db,
          rows,
          SOURCE_TYPE_API,
          undefined,
          options?.metricStreamPublisher,
        );

        return { recordCount: rows.length, result: rows.length, degradations };
      },
      options?.userId,
    );
    return hrCount;
  } catch (err) {
    errors.push({
      message: `heart_rate: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncTags(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const tagCount = await withSyncLog(
      db,
      providerId,
      "tags",
      async () => {
        const tagPages = await fetchOuraPages(providerId, "tags", (nextToken) =>
          client.getTags(sinceDate, todayDate, nextToken),
        );

        let count = 0;
        for (const tag of tagPages.items) {
          await db
            .insert(healthEvent)
            .values({
              providerId,
              externalId: tag.id,
              type: "oura_tag",
              valueText: tag.tags.join(", "),
              startDate: new Date(tag.timestamp),
            })
            .onConflictDoUpdate({
              target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
              set: { valueText: tag.tags.join(", ") },
            });
          count++;
        }

        return { recordCount: count, result: count, degradations: tagPages.degradations };
      },
      options?.userId,
    );
    return tagCount;
  } catch (err) {
    errors.push({
      message: `tags: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncEnhancedTags(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const enhancedTagCount = await withSyncLog(
      db,
      providerId,
      "enhanced_tags",
      async () => {
        const enhancedTagPages = await fetchOuraPages(providerId, "enhanced_tags", (nextToken) =>
          client.getEnhancedTags(sinceDate, todayDate, nextToken),
        );

        let count = 0;
        for (const enhancedTag of enhancedTagPages.items) {
          const tagName = enhancedTag.custom_name ?? enhancedTag.tag_type_code ?? "unknown";
          await db
            .insert(healthEvent)
            .values({
              providerId,
              externalId: enhancedTag.id,
              type: "oura_enhanced_tag",
              valueText: tagName,
              startDate: new Date(enhancedTag.start_time),
              endDate: enhancedTag.end_time ? new Date(enhancedTag.end_time) : undefined,
            })
            .onConflictDoUpdate({
              target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
              set: {
                valueText: tagName,
                endDate: enhancedTag.end_time ? new Date(enhancedTag.end_time) : undefined,
              },
            });
          count++;
        }

        return {
          recordCount: count,
          result: count,
          degradations: enhancedTagPages.degradations,
        };
      },
      options?.userId,
    );
    return enhancedTagCount;
  } catch (err) {
    errors.push({
      message: `enhanced_tags: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncRestMode(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const restModeCount = await withSyncLog(
      db,
      providerId,
      "rest_mode",
      async () => {
        const restModePages = await fetchOuraPages(providerId, "rest_mode", (nextToken) =>
          client.getRestModePeriods(sinceDate, todayDate, nextToken),
        );

        let count = 0;
        for (const rm of restModePages.items) {
          const startDate = rm.start_time
            ? new Date(rm.start_time)
            : new Date(`${rm.start_day}T00:00:00`);
          const endDate = rm.end_time
            ? new Date(rm.end_time)
            : rm.end_day
              ? new Date(`${rm.end_day}T23:59:59`)
              : undefined;

          await db
            .insert(healthEvent)
            .values({
              providerId,
              externalId: rm.id,
              type: "oura_rest_mode",
              startDate,
              endDate,
            })
            .onConflictDoUpdate({
              target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
              set: { endDate },
            });
          count++;
        }

        return {
          recordCount: count,
          result: count,
          degradations: restModePages.degradations,
        };
      },
      options?.userId,
    );
    return restModeCount;
  } catch (err) {
    errors.push({
      message: `rest_mode: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncDailyMetricsComposite(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    return await withSyncLog(
      db,
      providerId,
      "daily_metrics",
      async () => {
        let count = 0;
        const degradations: SyncDegradation[] = [];

        const [activityPages, spo2Pages, sleepPages] = await Promise.all([
          fetchOuraPages(providerId, "daily_activity", (nextToken) =>
            client.getDailyActivity(sinceDate, todayDate, nextToken),
          ),
          fetchOuraPages(providerId, "daily_spo2", (nextToken) =>
            client.getDailySpO2(sinceDate, todayDate, nextToken),
          ),
          fetchOuraPages(providerId, "sleep", (nextToken) =>
            client.getSleep(sinceDate, todayDate, nextToken),
          ),
        ]);

        for (const pageResult of [activityPages, spo2Pages, sleepPages]) {
          degradations.push(...pageResult.degradations);
        }

        const allActivity = activityPages.items;
        const allSpO2 = spo2Pages.items;
        const allSleep = sleepPages.items;

        const activityByDay = new Map<string, OuraDailyActivity>();
        for (const activityDoc of allActivity) activityByDay.set(activityDoc.day, activityDoc);

        const spo2ByDay = new Map<string, OuraDailySpO2>();
        for (const spo2 of allSpO2) spo2ByDay.set(spo2.day, spo2);

        // Index primary sleep (long_sleep/sleep) by day for HRV + resting HR.
        // Prefer long_sleep over other types since it represents the main overnight session.
        const primarySleepByDay = new Map<string, OuraSleepDocument>();
        for (const sleepDoc of allSleep) {
          if (sleepDoc.type === "long_sleep" || sleepDoc.type === "sleep") {
            const existing = primarySleepByDay.get(sleepDoc.day);
            if (!existing || (sleepDoc.type === "long_sleep" && existing.type !== "long_sleep")) {
              primarySleepByDay.set(sleepDoc.day, sleepDoc);
            }
          }
        }

        // Union of all days
        const allDays = new Set([
          ...activityByDay.keys(),
          ...spo2ByDay.keys(),
          ...primarySleepByDay.keys(),
        ]);

        for (const day of allDays) {
          const activityDoc = activityByDay.get(day) ?? null;
          const spo2 = spo2ByDay.get(day) ?? null;
          const sleep = primarySleepByDay.get(day) ?? null;
          const parsed = parseOuraDailyMetrics(activityDoc, spo2, sleep);

          try {
            await db
              .insert(dailyMetrics)
              .values({
                date: parsed.date,
                providerId,
                steps: parsed.steps,
                hrv: parsed.hrv,
                spo2Avg: parsed.spo2Avg,
              })
              .onConflictDoUpdate({
                target: [
                  dailyMetrics.userId,
                  dailyMetrics.date,
                  dailyMetrics.providerId,
                  dailyMetrics.sourceName,
                ],
                set: {
                  steps: parsed.steps,
                  hrv: parsed.hrv,
                  spo2Avg: parsed.spo2Avg,
                },
              });
            count++;
          } catch (err) {
            errors.push({
              message: `daily_metrics ${day}: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            });
          }
        }

        return { recordCount: count, result: count, degradations };
      },
      options?.userId,
    );
  } catch (err) {
    errors.push({
      message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}
