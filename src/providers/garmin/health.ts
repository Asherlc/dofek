import { eq } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../../db/index.ts";
import { replaceMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import type { SyncOptions } from "../types.ts";
import {
  garminDailySchema,
  garminHrvSchema,
  garminPulseOxSchema,
  garminRespirationSchema,
  garminSleepSchema,
} from "./payloads.ts";

type HealthType = "dailies" | "sleeps" | "hrv" | "pulseox" | "allDayRespiration";
type DailyFields = Pick<
  typeof dailyMetrics.$inferInsert,
  "hrv" | "steps" | "distanceKm" | "flightsClimbed" | "exerciseMinutes"
>;

const stageNameSchema = z.enum(["deep", "light", "rem", "awake"]);

function minutes(seconds: number | null | undefined): number | null | undefined {
  return seconds == null ? seconds : Math.round(seconds / 60);
}

async function upsertDaily(
  db: SyncDatabase,
  userId: string,
  date: string,
  fields: DailyFields,
): Promise<void> {
  await db
    .insert(dailyMetrics)
    .values({
      userId,
      providerId: "garmin",
      date,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [
        dailyMetrics.userId,
        dailyMetrics.date,
        dailyMetrics.providerId,
        dailyMetrics.sourceName,
      ],
      set: { date, ...fields },
    });
}

async function replaceReadings(
  db: SyncDatabase,
  userId: string,
  family: HealthType,
  summary: { summaryId: string; startTimeInSeconds: number },
  field: "heartRate" | "spo2" | "respiratoryRate",
  readings: Record<string, number> | undefined,
  options: SyncOptions,
): Promise<void> {
  if (readings === undefined) return;
  const channels = { heartRate: "heart_rate", spo2: "spo2", respiratoryRate: "respiratory_rate" };
  const externalId = `${family}:${summary.summaryId}`;
  await replaceMetricStreamBatch(
    db,
    { userId, providerId: "garmin", externalId, channel: channels[field] },
    Object.entries(readings).map(([offset, value]) => ({
      userId,
      providerId: "garmin",
      externalId,
      recordedAt: new Date((summary.startTimeInSeconds + Number(offset)) * 1000),
      [field]: value,
    })),
    SOURCE_TYPE_API,
    options.metricStreamPublisher,
  );
}

async function persistSleep(
  db: SyncDatabase,
  userId: string,
  payload: unknown,
  options: SyncOptions,
): Promise<void> {
  const record = garminSleepSchema.parse(payload);
  const stages = Object.entries(record.sleepLevelsMap ?? {}).flatMap(([name, ranges]) => {
    const stage = stageNameSchema.parse(name, {
      error: () => `Unsupported Garmin sleep stage: ${name}`,
    });
    return ranges.map((range) => ({
      stage,
      startedAt: new Date(range.startTimeInSeconds * 1000),
      endedAt: new Date(range.endTimeInSeconds * 1000),
    }));
  });
  const startedAt = new Date(record.startTimeInSeconds * 1000);
  const endedAt =
    typeof record.awakeDurationInSeconds === "number"
      ? new Date(
          (record.startTimeInSeconds + record.durationInSeconds + record.awakeDurationInSeconds) *
            1000,
        )
      : null;
  const offsetSeconds = record.startTimeOffsetInSeconds;
  const fields = {
    startedAt,
    endedAt,
    durationMinutes: minutes(record.durationInSeconds),
    deepMinutes: minutes(record.deepSleepDurationInSeconds),
    lightMinutes: minutes(record.lightSleepDurationInSeconds),
    remMinutes: minutes(record.remSleepInSeconds),
    awakeMinutes: minutes(record.awakeDurationInSeconds),
    stagingAvailable: record.sleepLevelsMap === undefined ? undefined : stages.length > 0,
    ...(offsetSeconds !== undefined
      ? {
          startUtcOffsetMinutes: offsetSeconds / 60,
          localTimeSource: "provider_offset",
        }
      : {}),
  };

  await db.transaction(async (transaction) => {
    const [session] = await transaction
      .insert(sleepSession)
      .values({
        userId,
        providerId: "garmin",
        externalId: record.summaryId,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
        set: {
          ...fields,
          endedAt: record.awakeDurationInSeconds === undefined ? undefined : endedAt,
        },
      })
      .returning({ id: sleepSession.id });
    if (!session) throw new Error("Garmin sleep upsert did not return a session");
    if (record.sleepLevelsMap !== undefined) {
      await transaction.delete(sleepStage).where(eq(sleepStage.sessionId, session.id));
      if (stages.length > 0) {
        await transaction
          .insert(sleepStage)
          .values(stages.map((stage) => ({ sessionId: session.id, ...stage })));
      }
    }
  });

  await replaceReadings(db, userId, "sleeps", record, "spo2", record.timeOffsetSleepSpo2, options);
  await replaceReadings(
    db,
    userId,
    "sleeps",
    record,
    "respiratoryRate",
    record.timeOffsetSleepRespiration,
    options,
  );
}

export async function syncGarminHealthRecord(
  db: SyncDatabase,
  type: HealthType,
  payload: unknown,
  options: SyncOptions,
): Promise<number> {
  const userId = options.userId?.trim();
  if (!userId) throw new Error("Garmin health persistence requires userId");

  switch (type) {
    case "dailies": {
      const record = garminDailySchema.parse(payload);
      const moderate = record.moderateIntensityDurationInSeconds;
      const vigorous = record.vigorousIntensityDurationInSeconds;
      const exerciseMinutes =
        moderate === null || vigorous === null
          ? null
          : moderate !== undefined && vigorous !== undefined
            ? minutes(moderate + vigorous)
            : undefined;
      await upsertDaily(db, userId, record.calendarDate, {
        steps: record.steps,
        distanceKm:
          record.distanceInMeters == null
            ? record.distanceInMeters
            : record.distanceInMeters / 1000,
        flightsClimbed: record.floorsClimbed,
        exerciseMinutes,
      });
      await replaceReadings(
        db,
        userId,
        type,
        record,
        "heartRate",
        record.timeOffsetHeartRateSamples,
        options,
      );
      break;
    }
    case "hrv": {
      const record = garminHrvSchema.parse(payload);
      await upsertDaily(db, userId, record.calendarDate, { hrv: record.lastNightAvg });
      break;
    }
    case "pulseox": {
      const record = garminPulseOxSchema.parse(payload);
      await replaceReadings(db, userId, type, record, "spo2", record.timeOffsetSpo2Values, options);
      break;
    }
    case "allDayRespiration": {
      const record = garminRespirationSchema.parse(payload);
      await replaceReadings(
        db,
        userId,
        type,
        record,
        "respiratoryRate",
        record.timeOffsetEpochToBreaths,
        options,
      );
      break;
    }
    case "sleeps":
      await persistSleep(db, userId, payload, options);
      break;
  }
  return 1;
}
