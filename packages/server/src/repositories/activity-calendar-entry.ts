import type {
  ActivityDataState,
  ActivityDataStateUnavailableStatus,
} from "@dofek/format/activity-data-state";
import {
  localTimeContextUnknown,
  localTimeSourceSchema,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import type { ProviderAbsentSource } from "@dofek/providers/providers";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { getProvider } from "dofek/providers/registry";
import { z } from "zod";
import type { ActivityLocation } from "../contracts/activity-location.ts";
import type { ClimbingLogActivitySession } from "../contracts/climbing-log-contracts.ts";
import { pointMapPreview, routeMapPreview } from "../lib/map-preview.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  activityOriginColumnsSchema,
  activityOriginFromColumns,
} from "../models/activity-origin.ts";
import { ActivitySourceAttribution } from "../models/activity-source-attribution.ts";
import {
  type ActivityListSourceDetail,
  buildActivityListSource,
} from "../models/activity-source-decision.ts";
import { activityMeasurementState } from "../services/activity-data-state.ts";

export type ActivityStat =
  | {
      status: "available";
      label: string;
      value: string;
    }
  | {
      status: ActivityDataStateUnavailableStatus;
      label: string;
      reason: string;
    };

export interface CalendarActivityEntry {
  id: string;
  name: string | null;
  activityType: string;
  primaryActivityType: string | null;
  modality: string | null;
  startedAt: string;
  endedAt: string | null;
  localTimeContext: RecordLocalTimeContext;
  durationMin: number | null;
  source: ActivityListSourceDetail;
  lastProcessedAt: string | null;
  distanceMeters: number | null;
  distanceState: ActivityDataState;
  elevationGainM: number | null;
  elevationState: ActivityDataState;
  location: ActivityLocation | null;
  tss: number | null;
  stats: ActivityStat[];
  isProviderAbsent?: boolean;
  providerId?: string;
  providerAbsentAt?: string | null;
  partialAbsentSources?: ProviderAbsentSource[];
}

export interface CalendarDayActivities {
  date: string;
  activities: CalendarActivityEntry[];
}

export const activityRowSchema = z.object({
  ...activityOriginColumnsSchema.shape,
  origin_evidence: z.array(
    z.object({
      upstreamMemberActivityId: z.string(),
      downstreamMemberActivityId: z.string(),
      field: z.string(),
      value: z.string(),
    }),
  ),
  id: z.string(),
  name: z.string().nullable(),
  canonical_type: z.string(),
  primary_canonical_type: z.string().nullable(),
  modality: z.string().nullable(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  provider_id: z.string(),
  source_name: z.string().nullable(),
  member_activity_ids: z.array(z.string()),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().nullable(),
  end_utc_offset_minutes: z.coerce.number().nullable(),
  local_time_source: localTimeSourceSchema,
  duration_min: z.coerce.number().nullable(),
  total_distance: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number().nullable(),
  centroid_lat: z.coerce.number().nullable(),
  centroid_lng: z.coerce.number().nullable(),
  local_date: dateStringSchema,
  last_processed_at: timestampStringSchema.nullable(),
  absent_source_external_ids: z
    .array(z.record(z.string(), z.string().nullable()))
    .optional()
    .default([]),
  source_external_ids: z.array(z.record(z.string(), z.string().nullable())).optional().default([]),
});

function authoritativeLocalTimeContext(
  row: Pick<
    z.infer<typeof activityRowSchema>,
    "timezone" | "start_utc_offset_minutes" | "end_utc_offset_minutes" | "local_time_source"
  >,
): RecordLocalTimeContext {
  if (row.local_time_source === "unknown") {
    return localTimeContextUnknown();
  }
  const timezone =
    row.local_time_source === "provider_timezone" ||
    row.local_time_source === "device_timezone" ||
    row.local_time_source === "user_home_timezone"
      ? row.timezone
      : null;
  return {
    timezone,
    startUtcOffsetMinutes: row.start_utc_offset_minutes,
    endUtcOffsetMinutes: row.end_utc_offset_minutes,
    source: row.local_time_source,
  };
}

export type ActivityListDateOrder = "oldest" | "newest";

export interface WeekListInput {
  weeks: number;
  endDate: string;
  /** Inclusive lower bound for explicit agenda ranges. Legacy week ranges omit this. */
  startDate?: string;
  /** Date sort for explicit agenda pages. Defaults to newest-first history order. */
  dateOrder?: ActivityListDateOrder;
  activityType?: string;
  includeProviderAbsent?: boolean;
}

export interface ActivityListPage {
  days: CalendarDayActivities[];
  totalCount: number;
  page: number;
  pageSize: number;
  /** Plan ownership for this completed page; only set for explicit startDate ranges. */
  plannedWindow?: { startDate: string; endDate: string } | null;
}

interface CalendarEntryContext {
  climbingLogSessions?: ClimbingLogActivitySession[];
  routePreview?: ReturnType<typeof routeMapPreview>;
  mapReadiness?: "processing" | "awaiting_summary" | "unavailable";
}

export function createActiveCalendarEntry(
  row: z.infer<typeof activityRowSchema>,
  context: CalendarEntryContext & { sourceLocations?: ClimbingMapLocation[] },
): CalendarActivityEntry {
  const sourceLocations = context.sourceLocations;
  let sourceLocation: ActivityLocation | null = null;
  if (sourceLocations?.length) {
    const sourcePreview = pointMapPreview(
      sourceLocations.map((location) => ({
        lat: location.coordinates.latitude,
        lng: location.coordinates.longitude,
        location,
      })),
    );
    sourceLocation = {
      kind: "climbing_source",
      mapPreview: sourcePreview.preview,
      sourcePoints: sourcePreview.points.map(({ x, y, point }) => ({
        x,
        y,
        location: point.location,
      })),
    };
  }

  const sourceAttribution = ActivitySourceAttribution.fromClickHouseRow(
    row.source_external_ids,
    row.absent_source_external_ids,
  );
  const sourceLinks = sourceAttribution.toSourceLinks(getProvider);
  return {
    ...projectCalendarEntry(
      row,
      context,
      buildActivityListSource(
        activityOriginFromColumns(row),
        sourceLinks,
        getProvider,
        row.origin_evidence,
        context.climbingLogSessions,
      ),
      sourceLocation ??
        (context.mapReadiness != null && context.mapReadiness !== "unavailable"
          ? { kind: "processing" }
          : null),
    ),
    partialAbsentSources: sourceAttribution.hasPartialAbsence
      ? sourceAttribution.partialAbsentSources()
      : undefined,
  };
}

export function createProviderAbsentCalendarEntry(
  row: z.infer<typeof activityRowSchema> & { provider_absent_at: string },
  context: CalendarEntryContext,
): CalendarActivityEntry {
  return {
    ...projectCalendarEntry(
      row,
      context,
      buildActivityListSource(
        activityOriginFromColumns(row),
        ActivitySourceAttribution.fromClickHouseRow(
          row.source_external_ids,
          row.absent_source_external_ids,
        ).toSourceLinks(getProvider),
        getProvider,
        row.origin_evidence,
      ),
      context.mapReadiness === "processing" ? { kind: "processing" } : null,
    ),
    isProviderAbsent: true,
    providerId: row.provider_id,
    providerAbsentAt: row.provider_absent_at,
  };
}

function projectCalendarEntry(
  row: z.infer<typeof activityRowSchema>,
  context: CalendarEntryContext,
  source: ActivityListSourceDetail,
  sourceLocation: ActivityLocation | null,
): CalendarActivityEntry {
  return {
    id: row.id,
    name: row.name,
    activityType: row.canonical_type,
    primaryActivityType: row.primary_canonical_type,
    modality: row.modality,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    localTimeContext: authoritativeLocalTimeContext(row),
    durationMin: row.duration_min === null ? null : Math.round(row.duration_min * 10) / 10,
    source,
    lastProcessedAt: row.last_processed_at,
    distanceMeters: row.total_distance,
    distanceState: activityMeasurementState("Distance", row.total_distance),
    elevationGainM: row.elevation_gain_m,
    elevationState: activityMeasurementState("Elevation gain", row.elevation_gain_m),
    location:
      row.centroid_lat != null && row.centroid_lng != null
        ? {
            kind: "recorded_gps",
            centroidLat: row.centroid_lat,
            centroidLng: row.centroid_lng,
            mapPreview:
              context.routePreview ??
              routeMapPreview([{ lat: row.centroid_lat, lng: row.centroid_lng }]),
          }
        : sourceLocation,
    // Released clients still expect these fields. List cards no longer enrich training stress.
    tss: null,
    stats: [],
  };
}
