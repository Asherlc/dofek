import {
  localTimeSourceSchema,
  resolveNaiveWallClockInTimezone,
  resolveProviderTimezoneLocalTimeContext,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { z } from "zod";
import type { DerivedSnapshot } from "./activity-data-integrity-clickhouse.ts";
import {
  resolvePlausibleActivityLocalTime,
  type SuppliedActivityLocalTime,
} from "./activity-local-time.ts";

const postgresUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

export const activityIntegrityPostgresCandidateSchema = z.object({
  id: postgresUuidSchema,
  provider_id: z.string().min(1),
  external_id: z.string().min(1),
  user_id: postgresUuidSchema,
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().int().nullable(),
  end_utc_offset_minutes: z.coerce.number().int().nullable(),
  local_time_source: localTimeSourceSchema,
  rejected_provider_timezone: z.string().nullable(),
  rejected_provider_start_utc_offset_minutes: z.coerce.number().int().nullable(),
  rejected_provider_end_utc_offset_minutes: z.coerce.number().int().nullable(),
});

export const activityIntegrityLocalTimeContextSchema = z.object({
  timezone: z.string().nullable(),
  startUtcOffsetMinutes: z.number().int().nullable(),
  endUtcOffsetMinutes: z.number().int().nullable(),
  localTimeSource: localTimeSourceSchema,
  rejectedProviderTimezone: z.string().nullable(),
  rejectedProviderStartUtcOffsetMinutes: z.number().int().nullable(),
  rejectedProviderEndUtcOffsetMinutes: z.number().int().nullable(),
});

export const activityIntegrityPostgresArtifactRowSchema = z.object({
  id: postgresUuidSchema,
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  repairedStartedAt: z.string().datetime(),
  repairedEndedAt: z.string().datetime().nullable(),
  prior: activityIntegrityLocalTimeContextSchema,
  repaired: activityIntegrityLocalTimeContextSchema,
});

export type ActivityIntegrityPostgresCandidate = z.infer<
  typeof activityIntegrityPostgresCandidateSchema
>;
export type ActivityIntegrityPostgresArtifactRow = z.infer<
  typeof activityIntegrityPostgresArtifactRowSchema
>;

function localTimeContext(row: ActivityIntegrityPostgresCandidate) {
  return activityIntegrityLocalTimeContextSchema.parse({
    timezone: row.timezone,
    startUtcOffsetMinutes: row.start_utc_offset_minutes,
    endUtcOffsetMinutes: row.end_utc_offset_minutes,
    localTimeSource: row.local_time_source,
    rejectedProviderTimezone: row.rejected_provider_timezone,
    rejectedProviderStartUtcOffsetMinutes: row.rejected_provider_start_utc_offset_minutes,
    rejectedProviderEndUtcOffsetMinutes: row.rejected_provider_end_utc_offset_minutes,
  });
}

function normalizedLocalTimeContext(
  row: ActivityIntegrityPostgresCandidate,
  homeTimezone: string | null,
  coordinates?: { latitude: number; longitude: number },
) {
  const originalSupplied: SuppliedActivityLocalTime = {
    timezone: row.timezone,
    startUtcOffsetMinutes: row.start_utc_offset_minutes,
    endUtcOffsetMinutes: row.end_utc_offset_minutes,
    source:
      row.timezone?.trim() && row.local_time_source === "unknown"
        ? "provider_timezone"
        : row.local_time_source,
  };
  const supplied: SuppliedActivityLocalTime =
    row.timezone?.trim() &&
    (row.local_time_source === "provider_timezone" || row.local_time_source === "unknown")
      ? resolveProviderTimezoneLocalTimeContext({
          startedAt: row.started_at,
          endedAt: row.ended_at,
          timezone: row.timezone,
        })
      : row.local_time_source === "unknown"
        ? {
            timezone: null,
            startUtcOffsetMinutes: null,
            endUtcOffsetMinutes: null,
            source: "unknown",
          }
        : resolveRecordLocalTimeContext({
            startedAt: row.started_at,
            endedAt: row.ended_at,
            timezone: row.timezone,
            startUtcOffsetMinutes: row.start_utc_offset_minutes,
            endUtcOffsetMinutes: row.end_utc_offset_minutes,
            source: row.local_time_source,
          });
  const resolution = resolvePlausibleActivityLocalTime({
    startedAt: row.started_at,
    endedAt: row.ended_at,
    supplied,
    homeTimezone,
    coordinates,
    requireReferenceTimezone: true,
  });
  return activityIntegrityLocalTimeContextSchema.parse({
    timezone: resolution.context.timezone,
    startUtcOffsetMinutes: resolution.context.startUtcOffsetMinutes,
    endUtcOffsetMinutes: resolution.context.endUtcOffsetMinutes,
    localTimeSource: resolution.context.source,
    rejectedProviderTimezone:
      (resolution.rejected ? originalSupplied.timezone : null) ?? row.rejected_provider_timezone,
    rejectedProviderStartUtcOffsetMinutes:
      (resolution.rejected ? originalSupplied.startUtcOffsetMinutes : null) ??
      row.rejected_provider_start_utc_offset_minutes,
    rejectedProviderEndUtcOffsetMinutes:
      (resolution.rejected ? originalSupplied.endUtcOffsetMinutes : null) ??
      row.rejected_provider_end_utc_offset_minutes,
  });
}

const summaryCoordinateSchema = z.object({
  activity_id: postgresUuidSchema,
  centroid_lat: z.number().nullable().optional(),
  centroid_lng: z.number().nullable().optional(),
});

function coordinatesByMember(snapshot: DerivedSnapshot) {
  const coordinates = new Map<string, { latitude: number; longitude: number }>();
  const summaries = snapshot.summaryRows.flatMap((row) => {
    const parsed = summaryCoordinateSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const summaryByActivityId = new Map(summaries.map((row) => [row.activity_id, row]));
  for (const deduped of snapshot.dedupedRows) {
    const summary = summaryByActivityId.get(deduped.activity_id);
    if (summary?.centroid_lat == null || summary.centroid_lng == null) continue;
    for (const memberActivityId of deduped.member_activity_ids) {
      coordinates.set(memberActivityId, {
        latitude: summary.centroid_lat,
        longitude: summary.centroid_lng,
      });
    }
  }
  return coordinates;
}

export function buildActivityIntegrityPostgresArtifactRows(
  rows: ActivityIntegrityPostgresCandidate[],
  homeTimezone: string | null,
  snapshot: DerivedSnapshot,
): ActivityIntegrityPostgresArtifactRow[] {
  const coordinates = coordinatesByMember(snapshot);
  return rows.map((row) => {
    let repairedStartedAt = row.started_at;
    let repairedEndedAt = row.ended_at;
    if (row.provider_id === "strong-csv" && row.local_time_source === "unknown") {
      if (!homeTimezone) {
        throw new Error("Strong timestamp repair requires the user's home timezone");
      }
      repairedStartedAt = resolveNaiveWallClockInTimezone(row.started_at, homeTimezone);
      repairedEndedAt = row.ended_at
        ? new Date(
            repairedStartedAt.getTime() + (row.ended_at.getTime() - row.started_at.getTime()),
          )
        : null;
    }
    const repairedRow = {
      ...row,
      started_at: repairedStartedAt,
      ended_at: repairedEndedAt,
    };
    return activityIntegrityPostgresArtifactRowSchema.parse({
      id: row.id,
      providerId: row.provider_id,
      externalId: row.external_id,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      repairedStartedAt: repairedStartedAt.toISOString(),
      repairedEndedAt: repairedEndedAt?.toISOString() ?? null,
      prior: localTimeContext(row),
      repaired: normalizedLocalTimeContext(repairedRow, homeTimezone, coordinates.get(row.id)),
    });
  });
}

export function activityIntegrityStatesEqual(row: ActivityIntegrityPostgresArtifactRow): boolean {
  return (
    row.startedAt === row.repairedStartedAt &&
    row.endedAt === row.repairedEndedAt &&
    JSON.stringify(row.prior) === JSON.stringify(row.repaired)
  );
}
