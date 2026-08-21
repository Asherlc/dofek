import { sql } from "drizzle-orm";
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
import { OuraApiError, type OuraClient } from "./client.ts";
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
  OuraDailyReadiness,
  OuraDailyResilience,
  OuraDailySpO2,
  OuraDailyStress,
  OuraHeartRate,
  OuraListResponse,
  OuraSleepDocument,
  OuraVO2Max,
} from "./schemas.ts";

interface OuraPagesResult<T> {
  items: T[];
  degradations: SyncDegradation[];
}

const HEALTH_EVENT_BATCH_SIZE = 1000;

function isOuraOptionalScopeError(err: unknown): boolean {
  return err instanceof OuraApiError && err.status === 401;
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

async function fetchOuraPagesOptional<T>(
  providerId: string,
  stepName: string,
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
  onPage?: (items: readonly T[]) => Promise<void> | void,
): Promise<OuraPagesResult<T>> {
  try {
    return await fetchOuraPages(providerId, stepName, fetchPage, onPage);
  } catch (err) {
    if (isOuraOptionalScopeError(err)) {
      return {
        items: [],
        degradations: [
          {
            kind: "optional_endpoint_unavailable",
            providerId,
            stepName,
            message: `Missing OAuth scope for ${stepName}`,
          },
        ],
      };
    }
    throw err;
  }
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

async function persistDailyStress(
  db: SyncDatabase,
  providerId: string,
  stressPages: OuraPagesResult<OuraDailyStress>,
): Promise<{ recordCount: number; result: number; degradations: SyncDegradation[] }> {
  const rows = stressPages.items.map((stress) => ({
    providerId,
    externalId: stress.id,
    type: "oura_daily_stress",
    value: stress.stress_high,
    valueText: stress.day_summary,
    startDate: new Date(`${stress.day}T00:00:00`),
  }));

  for (let i = 0; i < rows.length; i += HEALTH_EVENT_BATCH_SIZE) {
    await db
      .insert(healthEvent)
      .values(rows.slice(i, i + HEALTH_EVENT_BATCH_SIZE))
      .onConflictDoUpdate({
        target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
        set: {
          value: sql`excluded.value`,
          valueText: sql`excluded.value_text`,
        },
      });
  }

  return {
    recordCount: rows.length,
    result: rows.length,
    degradations: stressPages.degradations,
  };
}

async function persistDailyResilience(
  db: SyncDatabase,
  providerId: string,
  resiliencePages: OuraPagesResult<OuraDailyResilience>,
): Promise<{ recordCount: number; result: number; degradations: SyncDegradation[] }> {
  let count = 0;
  for (const resilience of resiliencePages.items) {
    await db
      .insert(healthEvent)
      .values({
        providerId,
        externalId: resilience.id,
        type: "oura_daily_resilience",
        valueText: resilience.level,
        startDate: new Date(`${resilience.day}T00:00:00`),
      })
      .onConflictDoUpdate({
        target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
        set: {
          valueText: resilience.level,
        },
      });
    count++;
  }

  return {
    recordCount: count,
    result: count,
    degradations: resiliencePages.degradations,
  };
}

export async function syncDailyStress(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const stressCount = await withSyncLog(
      db,
      providerId,
      "daily_stress",
      async () => {
        const stressPages = await fetchOuraPagesOptional(providerId, "daily_stress", (nextToken) =>
          client.getDailyStress(sinceDate, todayDate, nextToken),
        );

        return persistDailyStress(db, providerId, stressPages);
      },
      options?.userId,
    );
    return stressCount;
  } catch (err) {
    errors.push({
      message: `daily_stress: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncDailyStressWebhook(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const stressCount = await withSyncLog(
      db,
      providerId,
      "daily_stress",
      async () => {
        const stressPages = await fetchOuraPages(providerId, "daily_stress", (nextToken) =>
          client.getDailyStress(sinceDate, todayDate, nextToken),
        );

        return persistDailyStress(db, providerId, stressPages);
      },
      options?.userId,
    );
    return stressCount;
  } catch (err) {
    errors.push({
      message: `daily_stress: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncDailyResilience(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const resilienceCount = await withSyncLog(
      db,
      providerId,
      "daily_resilience",
      async () => {
        const resiliencePages = await fetchOuraPagesOptional(
          providerId,
          "daily_resilience",
          (nextToken) => client.getDailyResilience(sinceDate, todayDate, nextToken),
        );

        return persistDailyResilience(db, providerId, resiliencePages);
      },
      options?.userId,
    );
    return resilienceCount;
  } catch (err) {
    errors.push({
      message: `daily_resilience: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncDailyResilienceWebhook(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const resilienceCount = await withSyncLog(
      db,
      providerId,
      "daily_resilience",
      async () => {
        const resiliencePages = await fetchOuraPages(providerId, "daily_resilience", (nextToken) =>
          client.getDailyResilience(sinceDate, todayDate, nextToken),
        );

        return persistDailyResilience(db, providerId, resiliencePages);
      },
      options?.userId,
    );
    return resilienceCount;
  } catch (err) {
    errors.push({
      message: `daily_resilience: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncCardiovascularAge(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const cvAgeCount = await withSyncLog(
      db,
      providerId,
      "cardiovascular_age",
      async () => {
        const cvAgePages = await fetchOuraPagesOptional(
          providerId,
          "cardiovascular_age",
          (nextToken) => client.getDailyCardiovascularAge(sinceDate, todayDate, nextToken),
        );

        let count = 0;
        for (const cv of cvAgePages.items) {
          if (cv.vascular_age === null) continue;
          await db
            .insert(healthEvent)
            .values({
              providerId,
              externalId: `oura_cv_age:${cv.day}`,
              type: "oura_cardiovascular_age",
              value: cv.vascular_age,
              startDate: new Date(`${cv.day}T00:00:00`),
            })
            .onConflictDoUpdate({
              target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
              set: { value: cv.vascular_age },
            });
          count++;
        }

        return {
          recordCount: count,
          result: count,
          degradations: cvAgePages.degradations,
        };
      },
      options?.userId,
    );
    return cvAgeCount;
  } catch (err) {
    errors.push({
      message: `cardiovascular_age: ${err instanceof Error ? err.message : String(err)}`,
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

export async function syncSleepTime(context: SyncStepContext): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    const sleepTimeCount = await withSyncLog(
      db,
      providerId,
      "sleep_time",
      async () => {
        const sleepTimePages = await fetchOuraPages(providerId, "sleep_time", (nextToken) =>
          client.getSleepTime(sinceDate, todayDate, nextToken),
        );

        let count = 0;
        for (const st of sleepTimePages.items) {
          await db
            .insert(healthEvent)
            .values({
              providerId,
              externalId: st.id,
              type: "oura_sleep_time",
              valueText: st.recommendation,
              startDate: new Date(`${st.day}T00:00:00`),
            })
            .onConflictDoUpdate({
              target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
              set: { valueText: st.recommendation },
            });
          count++;
        }

        return {
          recordCount: count,
          result: count,
          degradations: sleepTimePages.degradations,
        };
      },
      options?.userId,
    );
    return sleepTimeCount;
  } catch (err) {
    errors.push({
      message: `sleep_time: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncDailyMetricsComposite(
  context: SyncStepContext,
  useOptionalFetch: boolean,
): Promise<number> {
  const { db, providerId, client, sinceDate, todayDate, errors, options } = context;
  try {
    return await withSyncLog(
      db,
      providerId,
      "daily_metrics",
      async () => {
        let count = 0;
        const degradations: SyncDegradation[] = [];

        const fetchStress = useOptionalFetch
          ? fetchOuraPagesOptional(providerId, "daily_stress", (nextToken) =>
              client.getDailyStress(sinceDate, todayDate, nextToken),
            )
          : fetchOuraPages(providerId, "daily_stress", (nextToken) =>
              client.getDailyStress(sinceDate, todayDate, nextToken),
            );

        const fetchResilience = useOptionalFetch
          ? fetchOuraPagesOptional(providerId, "daily_resilience", (nextToken) =>
              client.getDailyResilience(sinceDate, todayDate, nextToken),
            )
          : fetchOuraPages(providerId, "daily_resilience", (nextToken) =>
              client.getDailyResilience(sinceDate, todayDate, nextToken),
            );

        const fetchVO2Max = useOptionalFetch
          ? fetchOuraPagesOptional(providerId, "vO2_max", (nextToken) =>
              client.getVO2Max(sinceDate, todayDate, nextToken),
            )
          : fetchOuraPages(providerId, "vO2_max", (nextToken) =>
              client.getVO2Max(sinceDate, todayDate, nextToken),
            );

        const [
          readinessPages,
          activityPages,
          spo2Pages,
          vo2MaxPages,
          stressPages,
          resiliencePages,
          sleepPages,
        ] = await Promise.all([
          fetchOuraPages(providerId, "daily_readiness", (nextToken) =>
            client.getDailyReadiness(sinceDate, todayDate, nextToken),
          ),
          fetchOuraPages(providerId, "daily_activity", (nextToken) =>
            client.getDailyActivity(sinceDate, todayDate, nextToken),
          ),
          fetchOuraPages(providerId, "daily_spo2", (nextToken) =>
            client.getDailySpO2(sinceDate, todayDate, nextToken),
          ),
          fetchVO2Max,
          fetchStress,
          fetchResilience,
          fetchOuraPages(providerId, "sleep", (nextToken) =>
            client.getSleep(sinceDate, todayDate, nextToken),
          ),
        ]);

        for (const pageResult of [
          readinessPages,
          activityPages,
          spo2Pages,
          vo2MaxPages,
          stressPages,
          resiliencePages,
          sleepPages,
        ]) {
          degradations.push(...pageResult.degradations);
        }

        const allReadiness = readinessPages.items;
        const allActivity = activityPages.items;
        const allSpO2 = spo2Pages.items;
        const allVO2Max = vo2MaxPages.items;
        const allStress = stressPages.items;
        const allResilience = resiliencePages.items;
        const allSleep = sleepPages.items;

        // Index by day for merging
        const readinessByDay = new Map<string, OuraDailyReadiness>();
        for (const readiness of allReadiness) readinessByDay.set(readiness.day, readiness);

        const activityByDay = new Map<string, OuraDailyActivity>();
        for (const activityDoc of allActivity) activityByDay.set(activityDoc.day, activityDoc);

        const spo2ByDay = new Map<string, OuraDailySpO2>();
        for (const spo2 of allSpO2) spo2ByDay.set(spo2.day, spo2);

        const vo2maxByDay = new Map<string, OuraVO2Max>();
        for (const vo2max of allVO2Max) vo2maxByDay.set(vo2max.day, vo2max);

        const stressByDay = new Map<string, OuraDailyStress>();
        for (const stress of allStress) stressByDay.set(stress.day, stress);

        const resilienceByDay = new Map<string, OuraDailyResilience>();
        for (const resilience of allResilience) resilienceByDay.set(resilience.day, resilience);

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
          ...readinessByDay.keys(),
          ...activityByDay.keys(),
          ...spo2ByDay.keys(),
          ...vo2maxByDay.keys(),
          ...stressByDay.keys(),
          ...resilienceByDay.keys(),
        ]);

        for (const day of allDays) {
          const readiness = readinessByDay.get(day) ?? null;
          const activityDoc = activityByDay.get(day) ?? null;
          const spo2 = spo2ByDay.get(day) ?? null;
          const vo2max = vo2maxByDay.get(day) ?? null;
          const stress = stressByDay.get(day) ?? null;
          const resilience = resilienceByDay.get(day) ?? null;
          const sleep = primarySleepByDay.get(day) ?? null;
          const parsed = parseOuraDailyMetrics(
            readiness,
            activityDoc,
            spo2,
            vo2max,
            stress,
            resilience,
            sleep,
          );

          try {
            await db
              .insert(dailyMetrics)
              .values({
                date: parsed.date,
                providerId,
                steps: parsed.steps,
                hrv: parsed.hrv,
                exerciseMinutes: parsed.exerciseMinutes,
                skinTempC: parsed.skinTempC,
                spo2Avg: parsed.spo2Avg,
                stressHighMinutes: parsed.stressHighMinutes,
                recoveryHighMinutes: parsed.recoveryHighMinutes,
                resilienceLevel: parsed.resilienceLevel,
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
                  exerciseMinutes: parsed.exerciseMinutes,
                  skinTempC: parsed.skinTempC,
                  spo2Avg: parsed.spo2Avg,
                  stressHighMinutes: parsed.stressHighMinutes,
                  recoveryHighMinutes: parsed.recoveryHighMinutes,
                  resilienceLevel: parsed.resilienceLevel,
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
