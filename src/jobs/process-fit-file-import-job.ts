/// <reference path="../activity-export/garmin-fitsdk.d.ts" />

import { readFile, unlink } from "node:fs/promises";
import type { CanonicalActivityType } from "@dofek/training/training";
import { Decoder, Stream } from "@garmin/fitsdk";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { replaceMetricStreamBatch, writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_FILE } from "../db/sensor-channels.ts";
import { fitExternalId } from "../fit/external-id.ts";
import { parseFitFileInWorkerThread } from "../fit/parser-worker.ts";
import { fitRecordsToSensorSamples } from "../fit/records.ts";
import { logger } from "../logger.ts";
import { type FitFileImportJobData, fitFileImportJobDataSchema } from "./queues.ts";

interface FitFileImportJob {
  data: unknown;
}

export interface FitFileImportJobResult {
  recordsSynced: number;
  errors: Array<{ message: string }>;
}

const fitDateSchema = z.union([z.string(), z.date()]).transform((value, context) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a valid FIT timestamp",
    });
    return z.NEVER;
  }
  return date;
});

const weightScaleMessageSchema = z
  .object({
    timestamp: fitDateSchema,
    weight: z.number().optional(),
    percentFat: z.number().optional(),
    percentHydration: z.number().optional(),
    boneMass: z.number().optional(),
    muscleMass: z.number().optional(),
    bmi: z.number().optional(),
  })
  .passthrough();

const fitMessagesSchema = z.object({
  fileIdMesgs: z
    .array(
      z
        .object({
          type: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
  weightScaleMesgs: z.array(weightScaleMessageSchema).optional(),
});

const decodedFitSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  messages: fitMessagesSchema.optional(),
});

function normalizedFitSport(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[\s-]+/g, "_") ?? ""
  );
}

function activityTypeFromFitSession(
  session: Awaited<ReturnType<typeof parseFitFileInWorkerThread>>["session"],
): CanonicalActivityType {
  const sport = normalizedFitSport(session.sport);
  const subSport = normalizedFitSport(session.subSport);
  const typeBySport: Record<string, CanonicalActivityType> = {
    cycling: "cycling",
    road: "cycling",
    road_biking: "cycling",
    mountain: "cycling",
    mountain_biking: "cycling",
    virtual_activity: "indoor_cycling",
    virtual_ride: "indoor_cycling",
    indoor_cycling: "indoor_cycling",
    running: "running",
    treadmill: "running",
    treadmill_running: "running",
    trail: "trail_running",
    trail_running: "trail_running",
    walking: "walking",
    hiking: "hiking",
    swimming: "swimming",
    lap_swimming: "swimming",
    strength_training: "strength",
    training: "strength",
    rowing: "rowing",
    yoga: "yoga",
    skiing: "skiing",
  };
  for (const candidate of [subSport, sport]) {
    const activityType = typeBySport[candidate];
    if (activityType) return activityType;
  }
  return "other";
}

function decodeFitMessages(buffer: Buffer) {
  const decoder = new Decoder(Stream.fromBuffer(buffer));
  const decoded: unknown = decoder.read();
  const parsed = decodedFitSchema.parse(decoded);
  const decodedErrors = parsed.errors ?? [];
  if (decodedErrors.length > 0) {
    throw new Error(`FIT decoder reported ${decodedErrors.length} errors`);
  }
  return parsed.messages ?? {};
}

function isWeightFit(messages: z.infer<typeof fitMessagesSchema>): boolean {
  const fileType = messages.fileIdMesgs?.find((message) => message.type)?.type;
  return fileType === "weight" || (messages.weightScaleMesgs?.length ?? 0) > 0;
}

async function importWeightFit(
  db: SyncDatabase,
  data: FitFileImportJobData,
  messages: z.infer<typeof fitMessagesSchema>,
): Promise<FitFileImportJobResult> {
  const rows = messages.weightScaleMesgs ?? [];
  if (rows.length === 0) {
    return { recordsSynced: 0, errors: [] };
  }

  await writeMetricStreamBatch(
    db,
    rows.map((row) => ({
      providerId: data.providerId,
      userId: data.userId,
      externalId: `weight:${data.originalPath}:${row.timestamp.toISOString()}`,
      recordedAt: row.timestamp,
      sourceName: data.sourceName,
      weightKg: row.weight,
      bodyFatPct: row.percentFat,
      waterPct: row.percentHydration,
      boneMassKg: row.boneMass,
      muscleMassKg: row.muscleMass,
      bmi: row.bmi,
    })),
    SOURCE_TYPE_FILE,
  );

  return { recordsSynced: rows.length, errors: [] };
}

async function importActivityFit(
  db: SyncDatabase,
  data: FitFileImportJobData,
  buffer: Buffer,
): Promise<FitFileImportJobResult> {
  const fitActivity = await parseFitFileInWorkerThread(buffer);
  const summary = data.activitySummary;
  const externalId = summary?.externalId ?? fitExternalId(data.originalPath, buffer);
  const activityType = summary?.activityType ?? activityTypeFromFitSession(fitActivity.session);
  const startedAt = summary ? new Date(summary.startedAtIso) : fitActivity.session.startTime;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    return {
      recordsSynced: 0,
      errors: [{ message: `FIT file ${data.originalPath} is missing a valid start time` }],
    };
  }
  const endedAt = summary
    ? new Date(summary.endedAtIso)
    : new Date(startedAt.getTime() + fitActivity.session.totalElapsedTime * 1000);
  const name = summary?.name ?? `FIT ${activityType.replace(/_/g, " ")}`;

  const activity = await upsertProviderActivity(
    db,
    {
      providerId: data.providerId,
      userId: data.userId,
      externalId,
      activityType,
      startedAt,
      endedAt,
      name,
      sourceName: data.sourceName,
      raw: summary?.raw ?? { fitPath: data.originalPath, session: fitActivity.session.raw },
    },
    {
      activityType,
      startedAt,
      endedAt,
      name,
      sourceName: data.sourceName,
      raw: summary?.raw ?? { fitPath: data.originalPath, session: fitActivity.session.raw },
    },
  );

  if (activity?.id) {
    const rows = fitRecordsToSensorSamples(
      fitActivity.records,
      data.providerId,
      activity.id,
      activityType,
    ).map((row) => ({ ...row, userId: data.userId }));
    await replaceMetricStreamBatch(db, { activityId: activity.id }, rows, SOURCE_TYPE_FILE);
  }

  return { recordsSynced: summary ? 0 : 1, errors: [] };
}

export async function processFitFileImportJob(
  job: FitFileImportJob,
  db: SyncDatabase,
): Promise<FitFileImportJobResult> {
  const data = fitFileImportJobDataSchema.parse(job.data);
  const buffer = await readFile(data.filePath);
  try {
    const messages = decodeFitMessages(buffer);
    if (isWeightFit(messages)) {
      return await importWeightFit(db, data, messages);
    }
    return await importActivityFit(db, data, buffer);
  } finally {
    await unlink(data.filePath).catch((error: unknown) => {
      logger.warn("Failed to clean up FIT import file %s: %s", data.filePath, error);
    });
  }
}
