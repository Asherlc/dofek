import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import { sleepSession, sleepStage } from "dofek/db/schema";
import { sql } from "drizzle-orm";
import express, { Router } from "express";
import { z } from "zod";
import { validateCompanionToken } from "../companion/token-repository.ts";
import { logger } from "../logger.ts";

const PROVIDER_ID = "amazfit-zepp";
const PROVIDER_NAME = "Amazfit / Zepp";

const dailyMetricsDataSchema = z.object({
  steps: z.number().int().optional(),
  calories: z.number().optional(),
  distanceKm: z.number().optional(),
  standHours: z.number().int().optional(),
  spo2Avg: z.number().optional(),
  skinTempC: z.number().optional(),
  stressHighMinutes: z.number().int().optional(),
  exerciseMinutes: z.number().int().optional(),
});

const datetimeString = z.string().datetime({ offset: true });

const sleepStageSchema = z.object({
  stage: z.enum(["deep", "light", "rem", "awake"]),
  startedAt: datetimeString,
  endedAt: datetimeString,
});

const sleepSessionSchema = z.object({
  externalId: z.string(),
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
  externalId: z.string(),
  activityType: z.string(),
  startedAt: datetimeString,
  endedAt: datetimeString,
  name: z.string().optional(),
});

const ingestPayloadSchema = z.object({
  dailyMetrics: z.record(dailyMetricsDataSchema).optional(),
  sleepSessions: z.array(sleepSessionSchema).optional(),
  activities: z.array(activitySchema).optional(),
});

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

export function createIngestZosHealthRouter(deps: { db: Database }): Router {
  const router = Router();

  router.post("/zos-health", express.json(), async (req, res) => {
    const token = bearerTokenFromHeader(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: "Companion token is required." });
      return;
    }

    let userId: string;
    try {
      const validatedUserId = await validateCompanionToken(deps.db, token);
      if (!validatedUserId) {
        sendJson(res, 401, { error: "Invalid or revoked companion token." });
        return;
      }
      userId = validatedUserId;
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`[ingest-zos] Token validation failed: ${error}`);
      sendJson(res, 500, { error: "Failed to validate companion token." });
      return;
    }

    const parseResult = ingestPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      sendJson(res, 400, {
        error: "Invalid payload",
        details: parseResult.error.flatten(),
      });
      return;
    }

    const data = parseResult.data;

    if (!data.dailyMetrics && !data.sleepSessions && !data.activities) {
      sendJson(res, 400, {
        error: "At least one of dailyMetrics, sleepSessions, or activities is required.",
      });
      return;
    }

    try {
      // Ensure provider row exists
      await deps.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES (${PROVIDER_ID}, ${PROVIDER_NAME}, ${userId})
            ON CONFLICT (id) DO UPDATE SET name = ${PROVIDER_NAME}`,
      );

      // Process daily metrics — upsert with raw SQL since the unique
      // constraint is a NULLS NOT DISTINCT index on (user_id, date, provider_id, source_name)
      if (data.dailyMetrics) {
        for (const [dateStr, metrics] of Object.entries(data.dailyMetrics)) {
          const date = new Date(dateStr);
          if (Number.isNaN(date.getTime())) {
            logger.warn(`[ingest-zos] Invalid date: ${dateStr}, skipping`);
            continue;
          }
          await deps.db.execute(
            sql`INSERT INTO fitness.daily_metrics
                (date, provider_id, user_id, steps, active_energy_kcal, distance_km, stand_hours, spo2_avg, skin_temp_c, stress_high_minutes, exercise_minutes, source_name)
                VALUES (${dateStr}, ${PROVIDER_ID}, ${userId}, ${metrics.steps ?? null}, ${metrics.calories ?? null}, ${metrics.distanceKm ?? null}, ${metrics.standHours ?? null}, ${metrics.spo2Avg ?? null}, ${metrics.skinTempC ?? null}, ${metrics.stressHighMinutes ?? null}, ${metrics.exerciseMinutes ?? null}, 'zepp-companion')
                ON CONFLICT (user_id, date, provider_id, source_name)
                WHERE source_name = 'zepp-companion'
                DO UPDATE SET
                  steps = COALESCE(EXCLUDED.steps, daily_metrics.steps),
                  active_energy_kcal = COALESCE(EXCLUDED.active_energy_kcal, daily_metrics.active_energy_kcal),
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

      // Process sleep sessions — skip duplicates by unique (user_id, provider_id, external_id)
      if (data.sleepSessions) {
        for (const session of data.sleepSessions) {
          const sessionStartedAt = new Date(session.startedAt);
          const sessionEndedAt = new Date(session.endedAt);
          if (Number.isNaN(sessionStartedAt.getTime()) || Number.isNaN(sessionEndedAt.getTime())) {
            logger.warn(
              `[ingest-zos] Invalid sleep session dates for ${session.externalId}, skipping`,
            );
            continue;
          }

          const [insertedSession] = await deps.db
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
              sourceName: "zepp-companion",
            })
            .onConflictDoNothing({
              target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
            })
            .returning({ id: sleepSession.id });

          const existingSessionRows = await deps.db.execute(
            sql`SELECT id FROM fitness.sleep_session
                WHERE user_id = ${userId} AND provider_id = ${PROVIDER_ID} AND external_id = ${session.externalId}
                LIMIT 1`,
          );
          const existingId =
            existingSessionRows?.[0] != null &&
            typeof existingSessionRows[0] === "object" &&
            "id" in existingSessionRows[0] &&
            typeof existingSessionRows[0].id === "string"
              ? existingSessionRows[0].id
              : undefined;
          const sessionId = insertedSession?.id ?? existingId;

          if (session.stages && sessionId) {
            for (const stage of session.stages) {
              const stageStartedAt = new Date(stage.startedAt);
              const stageEndedAt = new Date(stage.endedAt);
              if (Number.isNaN(stageStartedAt.getTime()) || Number.isNaN(stageEndedAt.getTime())) {
                continue;
              }
              await deps.db
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

          await deps.db.execute(
            sql`INSERT INTO fitness.activity
                (provider_id, user_id, external_id, activity_type, started_at, ended_at, name, source_name)
                VALUES (${PROVIDER_ID}, ${userId}, ${act.externalId}, ${act.activityType}, ${activityStartedAt}, ${activityEndedAt}, ${act.name ?? null}, 'zepp-companion')
                ON CONFLICT (user_id, provider_id, external_id) DO NOTHING`,
          );
        }
      }

      sendJson(res, 200, { status: "ok" });
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`[ingest-zos] Failed to ingest health data: ${error}`);
      sendJson(res, 500, { error: "Failed to ingest health data." });
    }
  });

  return router;
}
