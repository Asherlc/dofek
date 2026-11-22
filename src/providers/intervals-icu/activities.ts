import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { STRAVA_ACTIVITY_TYPE_MAP } from "@dofek/training/training";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { replaceMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  ProviderActivityListSync,
} from "../../db/provider-activity-sync.ts";
import { activity } from "../../db/schema/activity.ts";
import {
  ALTITUDE,
  CADENCE,
  HEART_RATE,
  LOCATION,
  POWER,
  SOURCE_TYPE_API,
  SPEED,
  TEMPERATURE,
} from "../../db/sensor-channels.ts";
import type { SyncDegradation } from "../../sync/sync-degradation.ts";
import type { SyncRun } from "../sync-run.ts";
import type { SyncError } from "../types.ts";
import type { IntervalsIcuClient } from "./client.ts";

const STREAM_CONCURRENCY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const idSchema = z.union([z.string().trim().min(1), z.number().int()]).transform(String);
const listSchema = z.array(z.object({ id: idSchema }).passthrough());
const fullActivitySchema = z
  .object({
    id: idSchema,
    type: z.string().min(1),
    name: z.string().nullish(),
    start_date: z.iso.datetime(),
    start_date_local: z.iso.datetime({ local: true }).nullish(),
    timezone: z.string().nullish(),
    elapsed_time: z.number().nonnegative().nullish(),
    device_name: z.string().nullish(),
    device_watts: z.boolean().nullish(),
    stream_types: z.array(z.string()).nullish(),
    source: z.string().nullish(),
  })
  .passthrough();
const streamsSchema = z.array(
  z
    .object({ type: z.string(), data: z.unknown().optional(), data2: z.unknown().optional() })
    .passthrough(),
);
const timeSchema = z.array(z.number().int().nonnegative());
const samplesSchema = z.array(z.number().nullable());

const STREAM_TYPES = [
  "time",
  "raw_watts",
  "watts",
  "raw_heartrate",
  "heartrate",
  "cadence",
  "velocity_smooth",
  "altitude",
  "temp",
  "latlng",
];

const SCALAR_CHANNELS: ReadonlyArray<{
  channel: string;
  field: string;
  types: readonly string[];
}> = [
  { channel: POWER, field: "power", types: ["raw_watts", "watts"] },
  { channel: HEART_RATE, field: "heartRate", types: ["raw_heartrate", "heartrate"] },
  { channel: CADENCE, field: "cadence", types: ["cadence"] },
  { channel: SPEED, field: "speed", types: ["velocity_smooth"] },
  { channel: ALTITUDE, field: "altitude", types: ["altitude"] },
  { channel: TEMPERATURE, field: "temperature", types: ["temp"] },
];

export interface IntervalsIcuActivityResult {
  recordsSynced: number;
  errors: SyncError[];
  degradations: SyncDegradation[];
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function offsetMinutes(startUtc: Date, local: string | null | undefined): number | null {
  if (!local) return null;
  return Math.round((new Date(`${local}Z`).getTime() - startUtc.getTime()) / 60_000);
}

function requireUserId(run: SyncRun): string {
  if (!run.options.userId) throw new Error("Intervals.icu sync requires a user ID");
  return run.options.userId;
}

function mapType(type: string) {
  return resolveProviderActivityType(type, STRAVA_ACTIVITY_TYPE_MAP[type] ?? "other");
}

async function runBounded<T>(items: readonly T[], worker: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(STREAM_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(lanes);
}

interface PersistedActivity {
  externalId: string;
  activityId: string;
  startedAt: Date;
  deviceName: string | null;
  estimatedPower: boolean;
}

async function syncStreams(
  client: IntervalsIcuClient,
  run: SyncRun,
  providerId: string,
  persisted: PersistedActivity,
  result: IntervalsIcuActivityResult,
) {
  const { externalId, activityId, startedAt, deviceName, estimatedPower } = persisted;
  const degrade = (stream: string, message: string) =>
    result.degradations.push({
      kind: "record_rejected",
      providerId,
      stepName: "activity_streams",
      message: `Intervals.icu ${stream} stream ${message}; stored channel preserved`,
      externalId,
      context: { stream },
    });

  let streams: z.infer<typeof streamsSchema>;
  try {
    streams = await client.get(
      `/activity/${encodeURIComponent(externalId)}/streams.json`,
      streamsSchema,
      { query: { types: STREAM_TYPES.join(",") }, signal: run.options.signal },
    );
  } catch (error) {
    result.errors.push({
      message: `Streams for activity ${externalId}: ${error instanceof Error ? error.message : String(error)}`,
      externalId,
      cause: error,
    });
    return;
  }

  const byType = new Map(streams.map((stream) => [stream.type, stream]));
  const time = timeSchema.safeParse(byType.get("time")?.data);
  if (!time.success || new Set(time.data).size !== time.data.length) {
    if (byType.has("time")) degrade("time", "is malformed or has duplicate offsets");
    return;
  }
  const timeOffsets = time.data;
  const base = { providerId, activityId, sourceName: deviceName, userId: run.options.userId };
  const recordedAt = (index: number) =>
    new Date(startedAt.getTime() + (timeOffsets[index] ?? 0) * 1000);

  const replace = async (channel: string, rows: Parameters<typeof replaceMetricStreamBatch>[2]) => {
    // A complete, valid channel with no samples replaces (clears) the stored channel.
    try {
      await replaceMetricStreamBatch(
        run.db,
        { userId: requireUserId(run), activityId, channel },
        rows,
        SOURCE_TYPE_API,
        run.options.metricStreamPublisher,
      );
    } catch (error) {
      result.errors.push({
        message: `Stream ${channel} for activity ${externalId}: ${error instanceof Error ? error.message : String(error)}`,
        externalId,
        cause: error,
      });
    }
  };

  const samples = (type: string): number[] | (number | null)[] | undefined => {
    const stream = byType.get(type);
    if (!stream || stream.data === undefined) return undefined;
    const parsed = samplesSchema.safeParse(stream.data);
    if (!parsed.success || parsed.data.length !== timeOffsets.length) {
      degrade(type, "is malformed or does not match the time stream");
      return undefined;
    }
    return parsed.data;
  };

  for (const { channel, field, types } of SCALAR_CHANNELS) {
    // Power estimated by Intervals.icu (device_watts === false) is not measured evidence.
    if (channel === POWER && estimatedPower) continue;
    const type = types.find((candidate) => byType.has(candidate));
    const data = type ? samples(type) : undefined;
    if (!data) continue;
    const rows = data.flatMap((value, index) =>
      value == null ? [] : [{ ...base, recordedAt: recordedAt(index), [field]: value }],
    );
    await replace(channel, rows);
  }

  const latlng = byType.get("latlng");
  if (latlng) {
    const latitudes = samplesSchema.safeParse(latlng.data);
    const longitudes = samplesSchema.safeParse(latlng.data2);
    if (
      !latitudes.success ||
      !longitudes.success ||
      latitudes.data.length !== timeOffsets.length ||
      longitudes.data.length !== timeOffsets.length
    ) {
      degrade("latlng", "is malformed or does not match the time stream");
    } else {
      const rows = latitudes.data.flatMap((lat, index) => {
        const lng = longitudes.data[index];
        if (lat == null || lng == null) return [];
        return [{ ...base, recordedAt: recordedAt(index), lat, lng }];
      });
      await replace(LOCATION, rows);
    }
  }
}

/** Sync completed activities for the run window; reconciles absence only after a complete list. */
export async function syncIntervalsIcuActivities(
  client: IntervalsIcuClient,
  run: SyncRun,
  providerId: string,
): Promise<IntervalsIcuActivityResult> {
  const result: IntervalsIcuActivityResult = { recordsSynced: 0, errors: [], degradations: [] };
  const { since, until } = run.window;
  const listSync = new ProviderActivityListSync({
    db: run.db,
    providerId,
    windowStart: since,
    windowEnd: until,
    userId: run.options.userId,
  });

  let list: z.infer<typeof listSchema>;
  try {
    list = await client.get("/athlete/0/activities", listSchema, {
      // Local-date query padded by a day each side to cover any UTC offset; exact filtering below.
      query: {
        oldest: ymd(new Date(since.getTime() - DAY_MS)),
        newest: ymd(new Date(until.getTime() + DAY_MS)),
      },
      signal: run.options.signal,
    });
  } catch (error) {
    result.errors.push({
      message: `Activity list: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
    return result;
  }

  const persisted: PersistedActivity[] = [];
  const stubIds: string[] = [];
  let complete = true;
  for (const row of list) {
    const parsed = fullActivitySchema.safeParse(row);
    if (!parsed.success) {
      // Documented restricted Strava stub carries only an ID: presence evidence only.
      if (row.source === "STRAVA" && row.start_date == null && row.type == null) {
        stubIds.push(row.id);
        continue;
      }
      complete = false;
      result.degradations.push({
        kind: "schema_mismatch",
        providerId,
        stepName: "activity_list",
        message: "Intervals.icu activity does not match the expected shape",
        externalId: row.id,
      });
      continue;
    }
    const item = parsed.data;
    const startedAt = new Date(item.start_date);
    if (startedAt < since || startedAt >= until) continue;
    const endedAt =
      item.elapsed_time != null ? new Date(startedAt.getTime() + item.elapsed_time * 1000) : null;
    const activityType = mapType(item.type);
    const timezone = item.timezone?.trim() || null;
    const startOffset = offsetMinutes(startedAt, item.start_date_local);
    const localTime = timezone
      ? { timezone, localTimeSource: "provider_timezone" as const }
      : startOffset != null
        ? {
            startUtcOffsetMinutes: startOffset,
            endUtcOffsetMinutes: null,
            localTimeSource: "provider_offset" as const,
          }
        : {};
    const values = {
      providerId,
      userId: run.options.userId,
      externalId: item.id,
      activityType,
      startedAt,
      endedAt,
      name: item.name ?? null,
      sourceName: item.device_name ?? null,
      raw: { source: item.source ?? null },
      ...localTime,
    };
    try {
      const upserted = await listSync.upsert(values, {
        activityType,
        startedAt,
        endedAt,
        name: item.name ?? null,
        sourceName: item.device_name ?? null,
        raw: { source: item.source ?? null },
        ...localTime,
      });
      result.recordsSynced++;
      // An explicitly empty vendor stream_types list means no streams exist to request.
      if (upserted && item.stream_types?.length !== 0) {
        persisted.push({
          externalId: item.id,
          activityId: upserted.id,
          startedAt,
          deviceName: item.device_name ?? null,
          estimatedPower: item.device_watts === false,
        });
      }
    } catch (error) {
      complete = false;
      result.errors.push({
        message: `Activity ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
        externalId: item.id,
        cause: error,
      });
    }
  }

  // Restricted stubs carry no instant. Only stubs whose stored start is inside the exact window
  // count as present, so padded local-date rows cannot restore tombstones outside it.
  if (stubIds.length > 0) {
    try {
      const stored = await run.db
        .select({ externalId: activity.externalId })
        .from(activity)
        .where(
          and(
            eq(activity.providerId, providerId),
            eq(activity.userId, requireUserId(run)),
            inArray(activity.externalId, stubIds),
            gte(activity.startedAt, since),
            lt(activity.startedAt, until),
          ),
        );
      for (const row of stored) listSync.trackPresent(row.externalId);
    } catch (error) {
      complete = false;
      result.errors.push({
        message: `Restricted activity lookup: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  }

  await runBounded(persisted, (item) => syncStreams(client, run, providerId, item, result));

  if (complete && !run.options.signal?.aborted) {
    try {
      await finishProviderActivityListSync(run.db, {
        providerId,
        userId: run.options.userId,
        windowStart: since,
        windowEnd: until,
        presentExternalIds: listSync.presentExternalIds,
        // A successfully parsed empty list is authoritative for the exact window.
        emptyListIsAuthoritative: true,
      });
    } catch (error) {
      result.errors.push({
        message: `Activity reconciliation: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  }
  return result;
}
