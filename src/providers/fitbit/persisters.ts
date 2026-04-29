import { eq } from "drizzle-orm";
import type { SyncDatabase } from "../../db/index.ts";
import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import {
  activity,
  bodyMeasurement,
  dailyMetrics,
  metricStream,
  sleepSession,
} from "../../db/schema.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { logger } from "../../logger.ts";
import { parseTcx, tcxToSensorSamples } from "../../tcx/parser.ts";
import type { SyncError } from "../types.ts";
import type { FitbitActivity, FitbitClient } from "./client.ts";
import type {
  ParsedFitbitActivity,
  ParsedFitbitBodyMeasurement,
  ParsedFitbitDailyMetrics,
  ParsedFitbitSleep,
} from "./parsers.ts";

const PROVIDER_ID = "fitbit";

export async function persistActivity(
  db: SyncDatabase,
  parsed: ParsedFitbitActivity,
  raw: FitbitActivity,
  client?: FitbitClient,
): Promise<{ errors: SyncError[] }> {
  const errors: SyncError[] = [];

  const [row] = await db
    .insert(activity)
    .values({
      providerId: PROVIDER_ID,
      externalId: parsed.externalId,
      activityType: parsed.activityType,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      name: parsed.name,
      raw: raw,
    })
    .onConflictDoUpdate({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: {
        activityType: parsed.activityType,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        name: parsed.name,
        raw: raw,
      },
    })
    .returning({ id: activity.id });

  const activityId = row?.id;

  if (activityId && raw.tcxLink && client) {
    try {
      const tcxData = await client.downloadTcx(raw.tcxLink);
      const trackpoints = parseTcx(tcxData);
      const sampleRows = tcxToSensorSamples(trackpoints, PROVIDER_ID, activityId);

      if (sampleRows.length > 0) {
        await db.delete(metricStream).where(eq(metricStream.activityId, activityId));
        await writeMetricStreamBatch(db, sampleRows, SOURCE_TYPE_API);
        logger.info(
          `[fitbit] Inserted ${sampleRows.length} metric stream rows for activity ${parsed.externalId}`,
        );
      }
    } catch (tcxError) {
      errors.push({
        message: `TCX for ${parsed.externalId}: ${tcxError instanceof Error ? tcxError.message : String(tcxError)}`,
        externalId: parsed.externalId,
        cause: tcxError,
      });
    }
  }

  return { errors };
}

export async function persistSleep(db: SyncDatabase, parsed: ParsedFitbitSleep): Promise<void> {
  await db
    .insert(sleepSession)
    .values({
      providerId: PROVIDER_ID,
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
      },
    });
}

export async function persistDailyMetrics(
  db: SyncDatabase,
  parsed: ParsedFitbitDailyMetrics,
): Promise<void> {
  await db
    .insert(dailyMetrics)
    .values({
      date: parsed.date,
      providerId: PROVIDER_ID,
      steps: parsed.steps,
      activeEnergyKcal: parsed.activeEnergyKcal,
      exerciseMinutes: parsed.exerciseMinutes,
      distanceKm: parsed.distanceKm,
      flightsClimbed: parsed.flightsClimbed,
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
        activeEnergyKcal: parsed.activeEnergyKcal,
        exerciseMinutes: parsed.exerciseMinutes,
        distanceKm: parsed.distanceKm,
        flightsClimbed: parsed.flightsClimbed,
      },
    });
}

export async function persistBodyMeasurement(
  db: SyncDatabase,
  parsed: ParsedFitbitBodyMeasurement,
): Promise<void> {
  await db
    .insert(bodyMeasurement)
    .values({
      providerId: PROVIDER_ID,
      externalId: parsed.externalId,
      recordedAt: parsed.recordedAt,
      weightKg: parsed.weightKg,
      bodyFatPct: parsed.bodyFatPct,
    })
    .onConflictDoUpdate({
      target: [bodyMeasurement.userId, bodyMeasurement.providerId, bodyMeasurement.externalId],
      set: {
        weightKg: parsed.weightKg,
        bodyFatPct: parsed.bodyFatPct,
      },
    });
}
