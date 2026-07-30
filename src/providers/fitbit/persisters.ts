import type { SyncDatabase } from "../../db/index.ts";
import { replaceMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { dailyMetrics, sleepSession } from "../../db/schema/activity.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { logger } from "../../logger.ts";
import type { MetricStreamEventPublisher } from "../../metric-stream/redpanda-producer.ts";
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
  metricStreamPublisher?: MetricStreamEventPublisher,
): Promise<{ errors: SyncError[] }> {
  const errors: SyncError[] = [];

  const row = await upsertProviderActivity(
    db,
    {
      providerId: PROVIDER_ID,
      externalId: parsed.externalId,
      activityType: parsed.activityType,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      name: parsed.name,
      raw: raw,
    },
    {
      activityType: parsed.activityType,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      name: parsed.name,
      raw: raw,
    },
  );

  const activityId = row?.id;

  if (activityId && raw.tcxLink && client) {
    try {
      const tcxData = await client.downloadTcx(raw.tcxLink);
      const trackpoints = parseTcx(tcxData);
      const sampleRows = tcxToSensorSamples(trackpoints, PROVIDER_ID, activityId);

      if (sampleRows.length > 0) {
        await replaceMetricStreamBatch(
          db,
          { activityId },
          sampleRows,
          SOURCE_TYPE_API,
          metricStreamPublisher,
        );
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
      stagingAvailable: parsed.stagingAvailable,
      efficiencyPct: parsed.efficiencyPct,
      sleepType: parsed.sleepType,
      isNap: parsed.isNap,
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
        exerciseMinutes: parsed.exerciseMinutes,
        distanceKm: parsed.distanceKm,
        flightsClimbed: parsed.flightsClimbed,
      },
    });
}

export async function persistBodyMeasurement(
  db: SyncDatabase,
  parsed: ParsedFitbitBodyMeasurement,
  metricStreamPublisher?: MetricStreamEventPublisher,
): Promise<void> {
  await replaceMetricStreamBatch(
    db,
    { providerId: PROVIDER_ID, externalId: parsed.externalId },
    [
      {
        providerId: PROVIDER_ID,
        externalId: parsed.externalId,
        recordedAt: parsed.recordedAt,
        weightKg: parsed.weightKg,
        bodyFatPct: parsed.bodyFatPct,
      },
    ],
    SOURCE_TYPE_API,
    metricStreamPublisher,
  );
}
