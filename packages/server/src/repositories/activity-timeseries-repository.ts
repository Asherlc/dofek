import type { RecordLocalTimeContext } from "@dofek/format/record-local-time";
import { z } from "zod";
import { decodeAnalyticalCursor, encodeAnalyticalCursor } from "../mcp/analytical-cursor.ts";
import type { SourceReference } from "../mcp/analytical-evidence.ts";
import type { ActivityRow } from "../models/activity.ts";
import type { ActivitySensorStore, ActivitySensorWindow } from "./activity-repository.ts";
import {
  type ActivityTimeseriesColumn,
  type ActivityTimeseriesStream,
  type NativeActivityTimeseriesSample,
  synchronizeActivityTimeseries,
  type TimeseriesResolution,
} from "./activity-timeseries.ts";

const maximumOpenActivityMilliseconds = 12 * 60 * 60 * 1_000;

const nativeSampleRowSchema = z.object({
  recorded_at: z.string(),
  channel: z.string(),
  scalar: z.coerce.number().nullable(),
  lat: z.coerce.number().nullable(),
  lng: z.coerce.number().nullable(),
  provider_id: z.string().nullable(),
  member_activity_id: z.string().nullable(),
  device_id: z.string().nullable(),
  source_external_id: z.string().nullable(),
  source_type: z.string().nullable(),
  source_metric_stream_id: z.string().nullable(),
  measurement_kind: z.enum(["direct", "estimated", "unknown"]),
});

type NativeSampleRow = z.infer<typeof nativeSampleRowSchema>;

interface ActivityTimeseriesActivityRepository {
  findById(activityId: string): Promise<ActivityRow | null>;
  findSensorWindow(activityId: string): Promise<ActivitySensorWindow | null>;
}

interface ActivityTimeseriesSensorStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

export interface ActivityTimeseriesRequest {
  activityId: string;
  streams: ActivityTimeseriesStream[];
  resolution: TimeseriesResolution;
  fill: "none" | "linear";
  cursor: string | null;
  limit: number;
}

export interface ActivityTimeseriesPage {
  activity: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    sourceProviders: string[];
    memberActivityIds: string[];
    localTimeContext: RecordLocalTimeContext;
  };
  resolution: {
    requested: TimeseriesResolution;
    effectiveSeconds: number | null;
  };
  offsetsSeconds: number[];
  timestamps: string[];
  streams: Partial<Record<ActivityTimeseriesStream, ActivityTimeseriesColumn>>;
  sources: SourceReference[];
  nextCursor: string | null;
}

function requestShape(request: ActivityTimeseriesRequest): string {
  return JSON.stringify({
    fill: request.fill,
    resolution: request.resolution,
    streams: [...new Set(request.streams)].sort(),
  });
}

function resolutionSeconds(resolution: TimeseriesResolution): number | null {
  if (resolution === "raw") return null;
  return Number.parseInt(resolution, 10);
}

function normalizeTimestamp(value: string): string {
  const timestamp = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(timestamp).toISOString();
}

function sourceReference(row: NativeSampleRow, activityId: string): SourceReference {
  return {
    provider_id: row.provider_id ?? "unknown",
    device_id: row.device_id,
    source_type: row.source_type,
    source_record_id: row.source_external_id ?? row.source_metric_stream_id,
    activity_id: activityId,
    member_activity_id: row.member_activity_id,
    measurement_kind: row.measurement_kind,
  };
}

function nativeStream(channel: string): NativeActivityTimeseriesSample["stream"] | null {
  if (
    channel === "power" ||
    channel === "heart_rate" ||
    channel === "cadence" ||
    channel === "speed" ||
    channel === "distance" ||
    channel === "altitude" ||
    channel === "grade" ||
    channel === "temperature" ||
    channel === "moving_time" ||
    channel === "position"
  ) {
    return channel;
  }
  return null;
}

function buildNativeSamples(
  rows: readonly NativeSampleRow[],
  activityId: string,
): { samples: NativeActivityTimeseriesSample[]; sources: SourceReference[] } {
  const sources: SourceReference[] = [];
  const sourceIndexByKey = new Map<string, number>();
  const samples: NativeActivityTimeseriesSample[] = [];
  for (const row of rows) {
    const stream = nativeStream(row.channel);
    if (!stream) continue;
    const value = stream === "position" ? [row.lng, row.lat] : row.scalar;
    if (value === null || (Array.isArray(value) && (value[0] === null || value[1] === null))) {
      continue;
    }
    const source = sourceReference(row, activityId);
    const key = JSON.stringify(source);
    let sourceIndex = sourceIndexByKey.get(key);
    if (sourceIndex === undefined) {
      sourceIndex = sources.length;
      sources.push(source);
      sourceIndexByKey.set(key, sourceIndex);
    }
    samples.push({
      recordedAt: normalizeTimestamp(row.recorded_at),
      stream,
      value: Array.isArray(value) ? [value[0], value[1]] : value,
      sourceIndex,
    });
  }
  return { samples, sources };
}

function querySql(includePosition: boolean, raw: boolean): string {
  const scalarTimestampQuery = `SELECT recorded_at
      FROM analytics.activity_sensor_sample FINAL
      WHERE user_id = {userId:UUID}
        AND activity_id = {activityId:UUID}
        AND channel IN ({channels:Array(String)})
        AND recorded_at >= parseDateTime64BestEffort({pageStartedAt:String}, 6, 'UTC')
        AND recorded_at < parseDateTime64BestEffort({pageEndedAt:String}, 6, 'UTC')
        AND is_deleted = 0`;
  const locationTimestampQuery = includePosition
    ? `UNION ALL
      SELECT recorded_at
      FROM analytics.activity_location_sample FINAL
      WHERE user_id = {userId:UUID}
        AND activity_id = {activityId:UUID}
        AND recorded_at >= parseDateTime64BestEffort({pageStartedAt:String}, 6, 'UTC')
        AND recorded_at < parseDateTime64BestEffort({pageEndedAt:String}, 6, 'UTC')
        AND is_deleted = 0`
    : "";
  const timestampCte = raw
    ? `WITH selected_timestamps AS (
      SELECT recorded_at
      FROM (
        ${scalarTimestampQuery}
        ${locationTimestampQuery}
      )
      GROUP BY recorded_at
      ORDER BY recorded_at
      LIMIT {limit:UInt32}
    )`
    : "";
  const selectedTimestampPredicate = raw
    ? "AND recorded_at IN (SELECT recorded_at FROM selected_timestamps)"
    : `AND recorded_at >= parseDateTime64BestEffort({pageStartedAt:String}, 6, 'UTC')
        AND recorded_at < parseDateTime64BestEffort({pageEndedAt:String}, 6, 'UTC')`;
  const locationRows = includePosition
    ? `UNION ALL
    SELECT
      toString(recorded_at) AS recorded_at,
      'position' AS channel,
      CAST(NULL, 'Nullable(Float64)') AS scalar,
      lat,
      lng,
      provider_id,
      toString(member_activity_id) AS member_activity_id,
      device_id,
      source_external_id,
      source_type,
      toString(source_metric_stream_id) AS source_metric_stream_id,
      measurement_kind
    FROM analytics.activity_location_sample FINAL
    WHERE user_id = {userId:UUID}
      AND activity_id = {activityId:UUID}
      ${selectedTimestampPredicate}
      AND is_deleted = 0`
    : "";
  return `${timestampCte}
    SELECT
      toString(recorded_at) AS recorded_at,
      channel,
      toFloat64(scalar) AS scalar,
      CAST(NULL, 'Nullable(Float64)') AS lat,
      CAST(NULL, 'Nullable(Float64)') AS lng,
      provider_id,
      toString(member_activity_id) AS member_activity_id,
      device_id,
      source_external_id,
      source_type,
      toString(source_metric_stream_id) AS source_metric_stream_id,
      measurement_kind
    FROM analytics.activity_sensor_sample FINAL
    WHERE user_id = {userId:UUID}
      AND activity_id = {activityId:UUID}
      AND channel IN ({channels:Array(String)})
      ${selectedTimestampPredicate}
      AND is_deleted = 0
    ${locationRows}
    ORDER BY recorded_at, channel`;
}

function effectiveActivityEnd(window: ActivitySensorWindow): string {
  return (
    window.endedAt ??
    new Date(Date.parse(window.startedAt) + maximumOpenActivityMilliseconds).toISOString()
  );
}

export class ActivityTimeseriesRepository {
  readonly #activities: ActivityTimeseriesActivityRepository;
  readonly #sensorStore: ActivityTimeseriesSensorStore;

  constructor(
    activities: ActivityTimeseriesActivityRepository,
    sensorStore: Pick<ActivitySensorStore, "query">,
  ) {
    this.#activities = activities;
    this.#sensorStore = sensorStore;
  }

  async list(request: ActivityTimeseriesRequest): Promise<ActivityTimeseriesPage> {
    const activity = await this.#activities.findById(request.activityId);
    if (!activity) throw new Error("Activity not found or not accessible.");
    const window = await this.#activities.findSensorWindow(request.activityId);
    if (!window) throw new Error("Activity not found or not accessible.");

    const shape = requestShape(request);
    const cursor = request.cursor
      ? decodeAnalyticalCursor(request.cursor, {
          userId: window.userId,
          activityId: window.activityId,
          shape,
        })
      : null;
    const activityEnd = effectiveActivityEnd(window);
    const bucketSeconds = resolutionSeconds(request.resolution);
    const pageStartedAt = cursor?.nextRecordedAt ?? window.startedAt;
    const pageEndedAt =
      bucketSeconds === null
        ? activityEnd
        : new Date(
            Math.min(
              Date.parse(activityEnd),
              Date.parse(pageStartedAt) + request.limit * bucketSeconds * 1_000,
            ),
          ).toISOString();
    const requestedNativeStreams = request.streams.filter(
      (stream) => stream !== "elapsed_time" && stream !== "position" && stream !== "moving_time",
    );
    if (request.streams.includes("moving_time")) requestedNativeStreams.push("speed");
    const channels = [...new Set(requestedNativeStreams)].sort();
    const rows = await this.#sensorStore.query(
      nativeSampleRowSchema,
      querySql(request.streams.includes("position"), request.resolution === "raw"),
      {
        userId: window.userId,
        activityId: window.activityId,
        channels,
        pageStartedAt,
        pageEndedAt,
        limit: request.limit + 1,
      },
    );
    const movingTimeHistoryRows =
      request.streams.includes("moving_time") &&
      Date.parse(pageStartedAt) > Date.parse(window.startedAt)
        ? await this.#sensorStore.query(nativeSampleRowSchema, querySql(false, false), {
            userId: window.userId,
            activityId: window.activityId,
            channels: ["speed"],
            pageStartedAt: window.startedAt,
            pageEndedAt: pageStartedAt,
            limit: request.limit + 1,
          })
        : [];

    const normalizedRows = rows.map((row) => ({
      ...row,
      recorded_at: normalizeTimestamp(row.recorded_at),
    }));
    const uniqueTimestamps = [...new Set(normalizedRows.map((row) => row.recorded_at))].sort();
    const nextTimestamp =
      request.resolution === "raw" ? (uniqueTimestamps[request.limit] ?? null) : null;
    const pageRows = nextTimestamp
      ? normalizedRows.filter((row) => row.recorded_at < nextTimestamp)
      : normalizedRows;
    const { samples, sources } = buildNativeSamples(
      [...movingTimeHistoryRows, ...pageRows],
      window.activityId,
    );
    const synchronized = synchronizeActivityTimeseries({
      startedAt: window.startedAt,
      endedAt: request.resolution === "raw" ? window.endedAt : pageEndedAt,
      rangeStartedAt: pageStartedAt,
      streams: request.streams,
      resolution: request.resolution,
      fill: request.fill,
      samples,
    });
    const nextRecordedAt =
      nextTimestamp ??
      (request.resolution !== "raw" && Date.parse(pageEndedAt) < Date.parse(activityEnd)
        ? pageEndedAt
        : null);

    return {
      activity: {
        id: window.activityId,
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        sourceProviders: activity.source_providers ?? [activity.provider_id],
        memberActivityIds: window.memberActivityIds,
        localTimeContext: {
          timezone: activity.timezone,
          startUtcOffsetMinutes: activity.start_utc_offset_minutes,
          endUtcOffsetMinutes: activity.end_utc_offset_minutes,
          source: activity.local_time_source,
        },
      },
      resolution: {
        requested: request.resolution,
        effectiveSeconds: synchronized.effectiveResolutionSeconds,
      },
      offsetsSeconds: synchronized.offsetsSeconds,
      timestamps: synchronized.timestamps,
      streams: synchronized.streams,
      sources,
      nextCursor: nextRecordedAt
        ? encodeAnalyticalCursor({
            version: 1,
            userId: window.userId,
            activityId: window.activityId,
            shape,
            nextRecordedAt,
          })
        : null,
    };
  }
}
