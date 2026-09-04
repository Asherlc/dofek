import { resolveRawProviderActivityType } from "@dofek/training/activity-types";
import type { Database } from "dofek/db";
import { sleepSession, sleepStage } from "dofek/db/schema/activity";
import { ensureProvider } from "dofek/db/tokens";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import express, { Router } from "express";
import { z } from "zod";
import { writeMetricStreamBatch } from "../../../../src/db/metric-stream-writer.ts";
import {
  HEART_RATE,
  SKIN_TEMPERATURE,
  SOURCE_TYPE_API,
  SPO2,
  STRESS,
} from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { validateCompanionToken } from "../companion/token-repository.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

const PROVIDER_ID = "amazfit-zepp";
const PROVIDER_NAME = "Amazfit / Zepp";

const dailyMetricsDataSchema = z.object({
  steps: z.number().int().optional(),
  distanceKm: z.number().optional(),
  standHours: z.number().int().optional(),
  spo2Avg: z.number().optional(),
  skinTempC: z.number().optional(),
  stressHighMinutes: z.number().int().optional(),
  exerciseMinutes: z.number().int().optional(),
});

// Zod 4 validates timezone offsets strictly; companion payloads may include
// pathological offsets that only fail once parsed by Date.
const datetimeString = z
  .string()
  .regex(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/,
  )
  .refine(
    (value) => {
      if (value.endsWith("Z")) return true;
      const match = /[+-](\d{2}):(\d{2})$/.exec(value);
      if (!match) return false;
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      return hours < 14 ? minutes <= 59 : hours === 14 && minutes === 0;
    },
    { message: "Invalid ISO 8601 timezone offset" },
  );

const sleepStageSchema = z.object({
  stage: z.enum(["deep", "light", "rem", "awake"]),
  startedAt: datetimeString,
  endedAt: datetimeString,
});

const sleepSessionSchema = z.object({
  externalId: z.string().trim().min(1),
  startedAt: datetimeString,
  endedAt: datetimeString,
  durationMinutes: z.number().int().optional(),
  deepMinutes: z.number().int().optional(),
  remMinutes: z.number().int().optional(),
  lightMinutes: z.number().int().optional(),
  awakeMinutes: z.number().int().optional(),
  efficiencyPct: z.number().optional(),
  stages: z.array(sleepStageSchema).optional(),
});

const activitySchema = z.object({
  externalId: z.string().trim().min(1),
  activityType: z.string(),
  startedAt: datetimeString,
  endedAt: datetimeString,
  name: z.string().trim().min(1).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const backgroundHealthSampleSchema = z.object({
  recordedAt: datetimeString,
  heartRate: z.number().positive().optional(),
  bloodOxygenPercent: z.number().positive().max(100).optional(),
  bodyTemperatureCelsius: z.number().optional(),
  stress: z.number().nonnegative().optional(),
});

const liveWorkoutSampleSchema = z.object({
  externalId: z.string().trim().min(1),
  recordedAt: datetimeString,
  heartRate: z.number().positive().optional(),
  metrics: z.record(z.string(), z.number()),
});

const watchSummarySchema = z.object({
  collectedAt: z.number().int(),
  date: z.iso.date(),
  timezoneOffsetMinutes: z
    .number()
    .int()
    .min(-14 * 60)
    .max(14 * 60),
  steps: z.number().int().nonnegative().optional(),
  stepsTarget: z.number().int().nonnegative().optional(),
  distance: z.number().nonnegative().optional(),
  heartRate: z.array(z.number()).optional(),
  restingHeartRate: z.number().positive().optional(),
  bloodOxygenCurrent: z.number().positive().max(100).optional(),
  spo2Recent: z
    .array(z.object({ spo2: z.number().positive().max(100), time: z.number().int() }))
    .optional(),
  bodyTemperatureCurrent: z.number().optional(),
  bodyTemperature: z.array(z.number()).optional(),
  stress: z.array(z.number()).optional(),
  standHours: z.number().int().nonnegative().optional(),
  pai: z.number().nonnegative().optional(),
  fatBurning: z.number().int().nonnegative().optional(),
});

const dailyMetricsSchema = z
  .record(z.string(), dailyMetricsDataSchema)
  .superRefine((metrics, context) => {
    for (const date of Object.keys(metrics)) {
      if (!z.iso.date().safeParse(date).success) {
        context.addIssue({ code: "custom", path: [date], message: "Invalid date" });
      }
    }
  });

const missingIngestSectionMessage =
  "At least one of dailyMetrics, sleepSessions, activities, backgroundSamples, liveWorkoutSamples, or watchSummary is required.";

const ingestPayloadSchema = z
  .object({
    dailyMetrics: dailyMetricsSchema.optional(),
    sleepSessions: z.array(sleepSessionSchema).optional(),
    activities: z.array(activitySchema).optional(),
    backgroundSamples: z.array(backgroundHealthSampleSchema).optional(),
    liveWorkoutSamples: z.array(liveWorkoutSampleSchema).optional(),
    watchSummary: watchSummarySchema.optional(),
  })
  .refine(
    (data) =>
      data.dailyMetrics !== undefined ||
      data.sleepSessions !== undefined ||
      data.activities !== undefined ||
      data.backgroundSamples !== undefined ||
      data.liveWorkoutSamples !== undefined ||
      data.watchSummary !== undefined,
    { message: missingIngestSectionMessage },
  );

const healthEnvelopeSchema = z.object({
  version: z.literal(1),
  batchId: z.string().trim().min(1),
  source: z.object({
    connectionType: z.enum(["zepp", "zepp-workout"]),
    installId: z.string().trim().min(1),
  }),
  events: z
    .array(
      z.object({
        eventId: z.string().trim().min(1),
        createdAt: datetimeString,
        payload: z.unknown(),
      }),
    )
    .min(1)
    .max(500),
});

const imuSampleSchema = z.object({
  tMs: z.number().int().nonnegative(),
  ax: z.number().finite(),
  ay: z.number().finite(),
  az: z.number().finite(),
  gx: z.number().finite(),
  gy: z.number().finite(),
  gz: z.number().finite(),
});

const imuPayloadSchema = z.object({
  segmentId: z.string().trim().min(1),
  sessionStartMs: z.number().int().nonnegative(),
  hasGyroscope: z.boolean(),
  samples: z.array(imuSampleSchema).min(1).max(100),
});

type IngestPayload = z.infer<typeof ingestPayloadSchema>;
type RejectedHealthEvent = {
  eventId: string;
  issues: Array<{ path: string; message: string }>;
};

function validationIssues(error: z.ZodError): RejectedHealthEvent["issues"] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "$",
    message: issue.message,
  }));
}

function combineIngestPayloads(payloads: readonly IngestPayload[]): IngestPayload {
  const combined: IngestPayload = {};
  for (const payload of payloads) {
    if (payload.dailyMetrics) {
      combined.dailyMetrics ??= {};
      for (const [date, metrics] of Object.entries(payload.dailyMetrics)) {
        combined.dailyMetrics[date] = { ...combined.dailyMetrics[date], ...metrics };
      }
    }
    if (payload.sleepSessions) {
      combined.sleepSessions = [...(combined.sleepSessions ?? []), ...payload.sleepSessions];
    }
    if (payload.activities) {
      combined.activities = [...(combined.activities ?? []), ...payload.activities];
    }
    if (payload.backgroundSamples) {
      combined.backgroundSamples = [
        ...(combined.backgroundSamples ?? []),
        ...payload.backgroundSamples,
      ];
    }
    if (payload.liveWorkoutSamples) {
      combined.liveWorkoutSamples = [
        ...(combined.liveWorkoutSamples ?? []),
        ...payload.liveWorkoutSamples,
      ];
    }
    if (payload.watchSummary) {
      combined.watchSummary = payload.watchSummary;
    }
  }
  return combined;
}

type WatchSummary = z.infer<typeof watchSummarySchema>;

function watchSummaryRecordedAt(summary: WatchSummary, minuteOfDay: number): string {
  const [year, month, day] = summary.date.split("-").map(Number);
  return new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, 0, minuteOfDay) +
      summary.timezoneOffsetMinutes * 60_000,
  ).toISOString();
}

function watchSummaryMetricRows(summary: WatchSummary, userId: string): MetricStreamRowInput[] {
  const rows: MetricStreamRowInput[] = [];
  const addRow = (recordedAt: string, channel: string, scalar: number) => {
    rows.push({
      recordedAt,
      userId,
      providerId: PROVIDER_ID,
      externalId: `zepp-summary-${recordedAt}-${channel}`,
      deviceId: "zepp-watch",
      sourceType: SOURCE_TYPE_API,
      channel,
      scalar,
    });
  };

  summary.heartRate?.forEach((value, minute) => {
    if (value > 0) addRow(watchSummaryRecordedAt(summary, minute), HEART_RATE, value);
  });
  summary.stress?.forEach((value, minute) => {
    if (value > 0) addRow(watchSummaryRecordedAt(summary, minute), STRESS, value);
  });
  summary.bodyTemperature?.forEach((value, interval) => {
    if (value > -1000) {
      addRow(watchSummaryRecordedAt(summary, interval * 5), SKIN_TEMPERATURE, value);
    }
  });
  summary.spo2Recent?.forEach((reading) => {
    addRow(new Date(reading.time * 1000).toISOString(), SPO2, reading.spo2 / 100);
  });

  const collectedAt = new Date(summary.collectedAt).toISOString();
  const currentMetrics: Array<[string, number | undefined]> = [
    ["zepp_resting_heart_rate", summary.restingHeartRate],
    ["zepp_daily_steps_target", summary.stepsTarget],
    ["zepp_daily_distance", summary.distance],
    [SPO2, summary.bloodOxygenCurrent === undefined ? undefined : summary.bloodOxygenCurrent / 100],
    [SKIN_TEMPERATURE, summary.bodyTemperatureCurrent],
    ["zepp_pai", summary.pai],
  ];
  for (const [channel, value] of currentMetrics) {
    if (value !== undefined) addRow(collectedAt, channel, value);
  }
  return rows;
}

function bearerTokenFromHeader(value: string | undefined): string | null {
  if (!value?.startsWith("Bearer ")) {
    return null;
  }
  const token = value.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function sendJson(res: import("express").Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function requestBatchId(body: unknown): string | null {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("batchId" in body) ||
    typeof body.batchId !== "string" ||
    body.batchId.trim().length === 0
  ) {
    return null;
  }
  return body.batchId;
}

export function createIngestZosHealthRouter(deps: {
  db: Database;
  metricStreamPublisher?: MetricStreamEventPublisher;
}): Router {
  const router = Router();

  router.post("/zos-health", express.json(), async (req, res) => {
    const token = bearerTokenFromHeader(req.headers.authorization);
    if (token === null) {
      sendJson(res, 401, { error: "Dofek connection is required." });
      return;
    }

    let userId: string;
    try {
      const validatedUserId = await validateCompanionToken(deps.db, token);
      if (!validatedUserId) {
        sendJson(res, 401, { error: "Invalid or revoked Dofek connection." });
        return;
      }
      userId = validatedUserId;
    } catch (error) {
      captureException(error);
      logger.error(`[ingest-zos] Token validation failed: ${error}`);
      sendJson(res, 500, { error: "Failed to validate Dofek connection." });
      return;
    }

    const envelopeResult = healthEnvelopeSchema.safeParse(req.body);
    if (!envelopeResult.success) {
      const details = envelopeResult.error.flatten();
      const issuePaths = Object.keys(details.fieldErrors).sort();
      logger.warn(
        `[ingest-zos] Invalid envelope ${JSON.stringify({
          batchId: requestBatchId(req.body),
          issueCount:
            details.formErrors.length +
            Object.values(details.fieldErrors).reduce(
              (count, errors) => count + (errors?.length ?? 0),
              0,
            ),
          issuePaths,
        })}`,
      );
      sendJson(res, 400, {
        error: "Invalid envelope",
        details,
      });
      return;
    }

    const rejected: RejectedHealthEvent[] = [];
    const acceptedCandidates: Array<{ eventId: string; payload: IngestPayload }> = [];
    let hasWatchSummary = false;
    for (const event of envelopeResult.data.events) {
      const payloadResult = ingestPayloadSchema.safeParse(event.payload);
      if (!payloadResult.success) {
        rejected.push({ eventId: event.eventId, issues: validationIssues(payloadResult.error) });
        continue;
      }
      if (payloadResult.data.watchSummary && hasWatchSummary) {
        rejected.push({
          eventId: event.eventId,
          issues: [
            { path: "watchSummary", message: "Only one watch summary is allowed per batch." },
          ],
        });
        continue;
      }
      hasWatchSummary ||= payloadResult.data.watchSummary !== undefined;
      acceptedCandidates.push({ eventId: event.eventId, payload: payloadResult.data });
    }

    if (rejected.length > 0) {
      logger.warn(
        `[ingest-zos] Rejected health events ${JSON.stringify({
          batchId: envelopeResult.data.batchId,
          rejectedEventCount: rejected.length,
          issuePaths: [
            ...new Set(rejected.flatMap((event) => event.issues.map((issue) => issue.path))),
          ].sort(),
        })}`,
      );
    }

    if (acceptedCandidates.length === 0) {
      sendJson(res, 200, { status: "ok", acceptedEventIds: [], rejected });
      return;
    }

    let acceptedEvents = acceptedCandidates;
    const preflightRejectedCount = rejected.length;

    try {
      await deps.db.transaction(async (database) => {
        await ensureProvider(database, PROVIDER_ID, PROVIDER_NAME, undefined, userId);

        const liveExternalIds = [
          ...new Set(
            acceptedEvents.flatMap(
              ({ payload }) => payload.liveWorkoutSamples?.map((sample) => sample.externalId) ?? [],
            ),
          ),
        ];
        if (liveExternalIds.length > 0) {
          const externalIdParameters = sql.join(
            liveExternalIds.map((externalId) => sql`${externalId}`),
            sql`, `,
          );
          const existingActivities = await executeWithSchema(
            database,
            z.object({ externalId: z.string() }),
            sql`SELECT external_id AS "externalId"
              FROM fitness.activity
              WHERE user_id = ${userId}
                AND provider_id = ${PROVIDER_ID}
                AND external_id = ANY(ARRAY[${externalIdParameters}]::text[])`,
          );
          const existingExternalIds = new Set(
            existingActivities.map((activity) => activity.externalId),
          );
          let remainingEvents = acceptedEvents;
          while (true) {
            const suppliedExternalIds = new Set(
              remainingEvents.flatMap(
                ({ payload }) => payload.activities?.map((activity) => activity.externalId) ?? [],
              ),
            );
            const nextEvents: typeof remainingEvents = [];
            let removedAny = false;
            for (const event of remainingEvents) {
              const missingExternalId = event.payload.liveWorkoutSamples?.find(
                (sample) =>
                  !existingExternalIds.has(sample.externalId) &&
                  !suppliedExternalIds.has(sample.externalId),
              )?.externalId;
              if (missingExternalId) {
                rejected.push({
                  eventId: event.eventId,
                  issues: [
                    {
                      path: "liveWorkoutSamples",
                      message: `Activity ${missingExternalId} was not found.`,
                    },
                  ],
                });
                removedAny = true;
              } else {
                nextEvents.push(event);
              }
            }
            remainingEvents = nextEvents;
            if (!removedAny) break;
          }
          acceptedEvents = remainingEvents;
        }

        const data = combineIngestPayloads(acceptedEvents.map((event) => event.payload));

        // Process daily metrics — upsert with raw SQL since the unique
        // constraint is a NULLS NOT DISTINCT index on (user_id, date, provider_id, source_name)
        const normalizedDailyMetrics = { ...data.dailyMetrics };
        if (data.watchSummary) {
          const summary = data.watchSummary;
          const existing = normalizedDailyMetrics[summary.date] ?? {};
          normalizedDailyMetrics[summary.date] = {
            ...existing,
            steps: summary.steps ?? existing.steps,
            standHours: summary.standHours ?? existing.standHours,
            exerciseMinutes: summary.fatBurning ?? existing.exerciseMinutes,
          };
        }
        if (Object.keys(normalizedDailyMetrics).length > 0) {
          for (const [dateStr, metrics] of Object.entries(normalizedDailyMetrics)) {
            await database.execute(
              sql`INSERT INTO fitness.daily_metrics
                (date, provider_id, user_id, steps, distance_km, stand_hours, spo2_avg, skin_temp_c, stress_high_minutes, exercise_minutes, source_name)
                VALUES (${dateStr}, ${PROVIDER_ID}, ${userId}, ${metrics.steps ?? null}, ${metrics.distanceKm ?? null}, ${metrics.standHours ?? null}, ${metrics.spo2Avg ?? null}, ${metrics.skinTempC ?? null}, ${metrics.stressHighMinutes ?? null}, ${metrics.exerciseMinutes ?? null}, 'zepp-companion')
                ON CONFLICT (user_id, date, provider_id, source_name)
                WHERE source_name = 'zepp-companion'
                DO UPDATE SET
                  steps = COALESCE(EXCLUDED.steps, daily_metrics.steps),
                  distance_km = COALESCE(EXCLUDED.distance_km, daily_metrics.distance_km),
                  stand_hours = COALESCE(EXCLUDED.stand_hours, daily_metrics.stand_hours),
                  spo2_avg = COALESCE(EXCLUDED.spo2_avg, daily_metrics.spo2_avg),
                  skin_temp_c = COALESCE(EXCLUDED.skin_temp_c, daily_metrics.skin_temp_c),
                  stress_high_minutes = COALESCE(EXCLUDED.stress_high_minutes, daily_metrics.stress_high_minutes),
                  exercise_minutes = COALESCE(EXCLUDED.exercise_minutes, daily_metrics.exercise_minutes),
                  source_name = 'zepp-companion'`,
            );
          }
        }

        if (data.watchSummary) {
          const rows = watchSummaryMetricRows(data.watchSummary, userId);
          if (rows.length > 0) {
            const publisher =
              deps.metricStreamPublisher ?? (await getDefaultMetricStreamEventPublisher());
            await writeMetricStreamRows({ database, publisher, rows });
          }
        }

        if (data.backgroundSamples && data.backgroundSamples.length > 0) {
          const publisher =
            deps.metricStreamPublisher ?? (await getDefaultMetricStreamEventPublisher());
          await writeMetricStreamBatch(
            database,
            data.backgroundSamples.map((sample) => ({
              recordedAt: new Date(sample.recordedAt),
              providerId: PROVIDER_ID,
              userId,
              externalId: `zepp-background-${sample.recordedAt}`,
              sourceName: "zepp-companion-background",
              heartRate: sample.heartRate,
              spo2:
                sample.bloodOxygenPercent === undefined
                  ? undefined
                  : sample.bloodOxygenPercent / 100,
              temperatureC: sample.bodyTemperatureCelsius,
              stress: sample.stress,
            })),
            SOURCE_TYPE_API,
            undefined,
            publisher,
          );
        }

        // Process sleep sessions — skip duplicates by unique (user_id, provider_id, external_id)
        if (data.sleepSessions) {
          for (const session of data.sleepSessions) {
            const sessionStartedAt = new Date(session.startedAt);
            const sessionEndedAt = new Date(session.endedAt);
            if (
              Number.isNaN(sessionStartedAt.getTime()) ||
              Number.isNaN(sessionEndedAt.getTime())
            ) {
              logger.warn(
                `[ingest-zos] Invalid sleep session dates for ${session.externalId}, skipping`,
              );
              continue;
            }

            const [insertedSession] = await database
              .insert(sleepSession)
              .values({
                providerId: PROVIDER_ID,
                userId,
                externalId: session.externalId,
                startedAt: sessionStartedAt,
                endedAt: sessionEndedAt,
                durationMinutes: session.durationMinutes ?? null,
                deepMinutes: session.deepMinutes ?? null,
                remMinutes: session.remMinutes ?? null,
                lightMinutes: session.lightMinutes ?? null,
                awakeMinutes: session.awakeMinutes ?? null,
                efficiencyPct: session.efficiencyPct ?? null,
                stagingAvailable:
                  session.deepMinutes != null &&
                  session.remMinutes != null &&
                  session.lightMinutes != null &&
                  session.awakeMinutes != null,
                sourceName: "zepp-companion",
              })
              .onConflictDoNothing({
                target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
              })
              .returning({ id: sleepSession.id });

            const existingSessionRows = await executeWithSchema(
              database,
              z.object({ id: z.string() }),
              sql`SELECT id FROM fitness.sleep_session
                WHERE user_id = ${userId} AND provider_id = ${PROVIDER_ID} AND external_id = ${session.externalId}
                LIMIT 1`,
            );
            const existingId = existingSessionRows[0]?.id;
            const sessionId = insertedSession?.id ?? existingId;

            if (session.stages && sessionId) {
              for (const stage of session.stages) {
                const stageStartedAt = new Date(stage.startedAt);
                const stageEndedAt = new Date(stage.endedAt);
                if (
                  Number.isNaN(stageStartedAt.getTime()) ||
                  Number.isNaN(stageEndedAt.getTime())
                ) {
                  continue;
                }
                await database
                  .insert(sleepStage)
                  .values({
                    sessionId,
                    stage: stage.stage,
                    startedAt: stageStartedAt,
                    endedAt: stageEndedAt,
                    sourceName: "zepp-companion",
                  })
                  .onConflictDoNothing();
              }
            }
          }
        }

        // Process activities — skip duplicates by unique (user_id, provider_id, external_id)
        if (data.activities) {
          for (const act of data.activities) {
            const activityStartedAt = new Date(act.startedAt);
            const activityEndedAt = new Date(act.endedAt);
            if (
              Number.isNaN(activityStartedAt.getTime()) ||
              Number.isNaN(activityEndedAt.getTime())
            ) {
              logger.warn(`[ingest-zos] Invalid activity dates for ${act.externalId}, skipping`);
              continue;
            }

            const raw = act.raw === undefined ? null : JSON.stringify(act.raw);
            const activityType = resolveRawProviderActivityType(act.activityType);
            await database.execute(
              sql`INSERT INTO fitness.activity
                (provider_id, user_id, external_id, canonical_type, provider_type, modality, started_at, ended_at, name, source_name, raw)
                VALUES (${PROVIDER_ID}, ${userId}, ${act.externalId}, ${activityType.canonicalType}, ${activityType.providerType}, ${activityType.modality}, ${activityStartedAt}, ${activityEndedAt}, ${act.name ?? null}, 'zepp-companion', ${raw}::jsonb)
                ON CONFLICT (user_id, provider_id, external_id) DO UPDATE SET
                  canonical_type = EXCLUDED.canonical_type,
                  provider_type = EXCLUDED.provider_type,
                  modality = EXCLUDED.modality,
                  ended_at = GREATEST(activity.ended_at, EXCLUDED.ended_at),
                  name = COALESCE(EXCLUDED.name, activity.name),
                  source_name = EXCLUDED.source_name,
                  raw = CASE
                    WHEN EXCLUDED.raw IS NULL THEN activity.raw
                    WHEN COALESCE(activity.raw, '{}'::jsonb) ? 'liveSnapshotsByRecordedAt'
                      OR EXCLUDED.raw ? 'liveSnapshotsByRecordedAt'
                    THEN jsonb_set(
                      COALESCE(activity.raw, '{}'::jsonb) || EXCLUDED.raw,
                      '{liveSnapshotsByRecordedAt}',
                      COALESCE(activity.raw->'liveSnapshotsByRecordedAt', '{}'::jsonb)
                        || COALESCE(EXCLUDED.raw->'liveSnapshotsByRecordedAt', '{}'::jsonb)
                    )
                    ELSE COALESCE(activity.raw, '{}'::jsonb) || EXCLUDED.raw
                  END`,
            );
          }
        }

        if (data.liveWorkoutSamples && data.liveWorkoutSamples.length > 0) {
          const publisher =
            deps.metricStreamPublisher ?? (await getDefaultMetricStreamEventPublisher());
          const rows: MetricStreamRowInput[] = [];
          const externalIds = [
            ...new Set(data.liveWorkoutSamples.map((sample) => sample.externalId)),
          ];
          const externalIdParameters = sql.join(
            externalIds.map((externalId) => sql`${externalId}`),
            sql`, `,
          );
          const activityRows = await executeWithSchema(
            database,
            z.object({ id: z.string().uuid(), externalId: z.string() }),
            sql`SELECT id::text AS id, external_id AS "externalId"
              FROM fitness.activity
              WHERE user_id = ${userId}
                AND provider_id = ${PROVIDER_ID}
                AND external_id = ANY(ARRAY[${externalIdParameters}]::text[])`,
          );
          const activityIdByExternalId = new Map(
            activityRows.map((activityRow) => [activityRow.externalId, activityRow.id]),
          );
          for (const sample of data.liveWorkoutSamples) {
            const activityId = activityIdByExternalId.get(sample.externalId);
            if (!activityId) throw new Error("Validated Zepp workout activity was not persisted.");
            const baseExternalId = `zepp-live-${sample.externalId}-${sample.recordedAt}`;
            if (sample.heartRate !== undefined) {
              rows.push({
                recordedAt: sample.recordedAt,
                userId,
                providerId: PROVIDER_ID,
                externalId: `${baseExternalId}-${HEART_RATE}`,
                activityId,
                deviceId: "zepp-workout-extension",
                sourceType: SOURCE_TYPE_API,
                channel: HEART_RATE,
                scalar: sample.heartRate,
              });
            }
            for (const [metric, value] of Object.entries(sample.metrics)) {
              const channel = `zepp_sport_${metric}`;
              rows.push({
                recordedAt: sample.recordedAt,
                userId,
                providerId: PROVIDER_ID,
                externalId: `${baseExternalId}-${channel}`,
                activityId,
                deviceId: "zepp-workout-extension",
                sourceType: SOURCE_TYPE_API,
                channel,
                scalar: value,
              });
            }
          }
          await writeMetricStreamRows({ database, publisher, rows });
        }
      });

      if (rejected.length > preflightRejectedCount) {
        logger.warn(
          `[ingest-zos] Rejected unresolved live workout events ${JSON.stringify({
            batchId: envelopeResult.data.batchId,
            rejectedEventCount: rejected.length - preflightRejectedCount,
          })}`,
        );
      }

      await invalidateAllUserQueries(userId);
      sendJson(res, 200, {
        status: "ok",
        acceptedEventIds: acceptedEvents.map((event) => event.eventId),
        rejected,
      });
    } catch (error) {
      captureException(error);
      logger.error(`[ingest-zos] Failed to ingest health data: ${error}`);
      sendJson(res, 500, { error: "Failed to ingest health data." });
    }
  });

  router.post("/zos-imu", express.json(), async (req, res) => {
    const token = bearerTokenFromHeader(req.headers.authorization);
    if (token === null) {
      sendJson(res, 401, { error: "Dofek connection is required." });
      return;
    }

    let userId: string;
    try {
      const validatedUserId = await validateCompanionToken(deps.db, token);
      if (!validatedUserId) {
        sendJson(res, 401, { error: "Invalid or revoked Dofek connection." });
        return;
      }
      userId = validatedUserId;
    } catch (error) {
      captureException(error);
      logger.error(`[ingest-zos-imu] Token validation failed: ${error}`);
      sendJson(res, 500, { error: "Failed to validate Dofek connection." });
      return;
    }

    const envelopeResult = healthEnvelopeSchema.safeParse(req.body);
    if (!envelopeResult.success) {
      sendJson(res, 400, { error: "Invalid envelope", details: envelopeResult.error.flatten() });
      return;
    }

    const rejected: RejectedHealthEvent[] = [];
    const acceptedCandidates: Array<{
      eventId: string;
      payload: z.infer<typeof imuPayloadSchema>;
    }> = [];
    for (const event of envelopeResult.data.events) {
      const payloadResult = imuPayloadSchema.safeParse(event.payload);
      if (!payloadResult.success) {
        rejected.push({ eventId: event.eventId, issues: validationIssues(payloadResult.error) });
      } else {
        acceptedCandidates.push({ eventId: event.eventId, payload: payloadResult.data });
      }
    }

    if (acceptedCandidates.length === 0) {
      sendJson(res, 200, { status: "ok", acceptedEventIds: [], rejected });
      return;
    }

    try {
      await deps.db.transaction(async (database) => {
        await ensureProvider(database, PROVIDER_ID, PROVIDER_NAME, undefined, userId);
        const rows = acceptedCandidates.flatMap(({ eventId, payload }) =>
          payload.samples.map((sample, sampleIndex) => {
            const recordedAt = new Date(payload.sessionStartMs + sample.tMs).toISOString();
            return {
              recordedAt,
              userId,
              providerId: PROVIDER_ID,
              externalId: `${PROVIDER_ID}:${envelopeResult.data.source.installId}:${eventId}:${sample.tMs}:${sampleIndex}`,
              deviceId: `${envelopeResult.data.source.connectionType}:${envelopeResult.data.source.installId}`,
              sourceType: SOURCE_TYPE_API,
              channel: payload.hasGyroscope ? "imu" : "accel",
              vector: payload.hasGyroscope
                ? [sample.ax, sample.ay, sample.az, sample.gx, sample.gy, sample.gz]
                : [sample.ax, sample.ay, sample.az],
            } satisfies MetricStreamRowInput;
          }),
        );
        const publisher =
          deps.metricStreamPublisher ?? (await getDefaultMetricStreamEventPublisher());
        await writeMetricStreamRows({ database, publisher, rows });
      });
      await invalidateAllUserQueries(userId);
      sendJson(res, 200, {
        status: "ok",
        acceptedEventIds: acceptedCandidates.map((event) => event.eventId),
        rejected,
      });
    } catch (error) {
      captureException(error);
      logger.error(`[ingest-zos-imu] Failed to ingest IMU data: ${error}`);
      sendJson(res, 500, { error: "Failed to ingest IMU data." });
    }
  });

  return router;
}
