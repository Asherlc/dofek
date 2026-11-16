import { TRPCError } from "@trpc/server";
import { retireActivityImages } from "dofek/db/activity-images";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivityMetricSourceSelection } from "../contracts/activity-metric-sources.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import type { RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import type { ActivityRow } from "../models/activity.ts";
import type {
  ActivityListItem,
  CountVisibleInWindowInput,
  ListInput,
  SearchInput,
} from "./activity-list-repository.ts";
import { ActivityListRepository } from "./activity-list-repository.ts";
import { postgresActivityCalendarDate } from "./activity-local-date.ts";
import {
  type ActivityIdResolution,
  activityDetailRowSchema,
  activityIdResolutionSchema,
  activitySensorWindowRowSchema,
  type activitySummaryReadModelRowSchema,
  type hrZoneRowSchema,
  type powerZoneRowSchema,
} from "./activity-repository-schemas.ts";
import type { StreamPoint } from "./activity-sensor-repository.ts";
import { ActivitySensorRepository } from "./activity-sensor-repository.ts";
import type {
  ActivitySensorQueryStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-sensor-types.ts";
import { withActivitySummaries } from "./activity-summary-enrichment.ts";

export type { ActivitySensorQueryOptions, ActivitySensorWindow } from "./activity-sensor-types.ts";

import { ActivityVisibilityRepository } from "./activity-visibility-repository.ts";

function activityNotFoundError(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
}

const powerCurveSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

const normalizedPowerSampleSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  activity_name: z.string().nullable(),
  power: z.coerce.number(),
  interval_s: z.coerce.number(),
});

const vo2MaxEstimateSchema = z.object({
  activity_id: z.string(),
  activity_date: dateStringSchema,
  method: z.string(),
  vo2max: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface ActivitySensorStore extends ActivitySensorQueryStore {
  getActivitySummaries(
    activityIds: string[],
  ): Promise<z.infer<typeof activitySummaryReadModelRowSchema>[]>;
  getPowerCurveSamples(
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ): Promise<z.infer<typeof powerCurveSampleSchema>[]>;
  getNormalizedPowerSamples(
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ): Promise<z.infer<typeof normalizedPowerSampleSchema>[]>;
  getVo2MaxEstimates(
    endDate: string,
    days: number,
    userId: string,
    timezone: string,
  ): Promise<z.infer<typeof vo2MaxEstimateSchema>[]>;
  getHeartRateCurveRows(
    days: RangeDays,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_hr: number; activity_date: string }>>;
  getPaceCurveRows(
    days: RangeDays,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_pace: number; activity_date: string }>>;
  getStream(
    window: ActivitySensorWindow,
    maxPoints: number,
    sources?: ActivityMetricSourceSelection,
  ): Promise<StreamPointRow[]>;
  getHeartRateZoneSeconds(window: ActivitySensorWindow): Promise<z.infer<typeof hrZoneRowSchema>[]>;
  getPowerZoneSeconds(
    window: ActivitySensorWindow,
    ftp: number,
    powerSourceId?: string,
  ): Promise<z.infer<typeof powerZoneRowSchema>[]>;
  refreshBodyMeasurements(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Factory for repositories that need activity visibility helpers without a sensor store. */
export function activityRepositoryFor(
  db: Pick<import("dofek/db").Database, "execute">,
  userId: string,
  timezone = "UTC",
  accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" },
): ActivityRepository {
  return new ActivityRepository(db, userId, timezone, accessWindow);
}

/** Data access for activity queries. */
export class ActivityRepository extends BaseRepository {
  readonly #sensorStore?: ActivitySensorStore;
  readonly #visibilityRepository: ActivityVisibilityRepository;
  readonly #listRepository: ActivityListRepository;
  readonly #sensorRepository: ActivitySensorRepository;
  readonly #activityIdResolutions = new Map<string, ActivityIdResolution | null>();

  constructor(
    db: Pick<import("dofek/db").Database, "execute">,
    userId: string,
    timezone = "UTC",
    accessWindow: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" },
    sensorStore?: ActivitySensorStore,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
    this.#visibilityRepository = new ActivityVisibilityRepository(
      db,
      userId,
      timezone,
      accessWindow,
    );
    this.#listRepository = new ActivityListRepository(
      db,
      userId,
      timezone,
      accessWindow,
      sensorStore,
    );
    this.#sensorRepository = new ActivitySensorRepository(db, userId, timezone, accessWindow);
  }

  /** Returns activity IDs currently visible in fitness.v_activity. */
  async resolveVisibleActivityIds(activityIds: readonly string[]): Promise<Set<string>> {
    return this.#visibilityRepository.resolveVisibleActivityIds(activityIds);
  }

  /** Returns visible canonical activity IDs since an inclusive local calendar date. */
  async listVisibleActivityIdsSince(localDate: string): Promise<string[]> {
    return this.#visibilityRepository.listVisibleActivityIdsSince(localDate);
  }

  /** Returns visible canonical activity IDs in a half-open local calendar range. */
  async listVisibleActivityIdsInRange(
    localStartDate: string,
    localEndDateExclusive: string,
  ): Promise<string[]> {
    return this.#visibilityRepository.listVisibleActivityIdsInRange(
      localStartDate,
      localEndDateExclusive,
    );
  }

  /** Drops rows whose ids are not currently visible in fitness.v_activity. */
  async filterToVisibleActivities<T extends { id: string }>(rows: readonly T[]): Promise<T[]>;
  async filterToVisibleActivities<T>(
    rows: readonly T[],
    getActivityId: (row: T) => string,
  ): Promise<T[]>;
  async filterToVisibleActivities<T>(
    rows: readonly T[],
    getActivityId?: (row: T) => string,
  ): Promise<T[]> {
    return this.#visibilityRepository.filterToVisibleActivities(rows, getActivityId);
  }

  /** Filters stable group-keyed ClickHouse rows to currently visible activities. */
  async filterToVisibleCanonicalActivities<T extends { id: string }>(
    rows: readonly T[],
  ): Promise<T[]> {
    return this.#visibilityRepository.filterToVisibleCanonicalActivities(rows);
  }

  /** Counts visible activities in fitness.v_activity for the requested window. */
  async countVisibleInWindow(input: CountVisibleInWindowInput): Promise<number> {
    return this.#listRepository.countVisibleInWindow(input);
  }

  /** Paginated activity list with summary metrics. */
  async list(input: ListInput): Promise<{ items: ActivityListItem[]; totalCount: number }> {
    return this.#listRepository.list(input);
  }

  /** Activities inside an exact inclusive local-date range, optionally filtered before paging. */
  async search(input: SearchInput): Promise<{ items: ActivityListItem[]; totalCount: number }> {
    return this.#listRepository.search(input);
  }

  /** All activities inside an exact inclusive local-date range for server-side aggregation. */
  async listRange(
    startDate: string,
    endDate: string,
    activityTypes?: string[],
  ): Promise<ActivityListItem[]> {
    return this.#listRepository.listRange(startDate, endDate, activityTypes);
  }

  /** Single activity with full detail row. Returns null when not found. */
  async findById(activityId: string): Promise<ActivityRow | null> {
    const resolution = await this.#resolveActivityId(activityId);
    if (!resolution) {
      return null;
    }

    const activeRow = await this.#findActiveByGroupId(resolution.resolved_group_id);
    if (activeRow) {
      return this.#attachResolution(activeRow, resolution);
    }
    const providerAbsentRow = await this.#findProviderAbsentByGroupId(resolution.resolved_group_id);
    return providerAbsentRow ? this.#attachResolution(providerAbsentRow, resolution) : null;
  }

  async #resolveActivityId(activityId: string): Promise<ActivityIdResolution | null> {
    if (this.#activityIdResolutions.has(activityId)) {
      return this.#activityIdResolutions.get(activityId) ?? null;
    }

    const rows = await this.query(
      activityIdResolutionSchema,
      sql`WITH identity_candidates AS (
            SELECT
              ${activityId}::uuid AS requested_id,
              activity_group.id AS resolved_group_id,
              'group'::text AS resolution_kind,
              1 AS precedence
            FROM fitness.activity_group
            WHERE activity_group.user_id = ${this.userId}::uuid
              AND activity_group.id = ${activityId}::uuid
              AND NOT EXISTS (
                SELECT 1
                FROM fitness.activity_group_alias retired_group
                WHERE retired_group.user_id = ${this.userId}::uuid
                  AND retired_group.alias_id = activity_group.id
              )
            UNION ALL
            SELECT
              ${activityId}::uuid,
              activity.group_id,
              'member'::text,
              2
            FROM fitness.activity
            WHERE activity.user_id = ${this.userId}::uuid
              AND activity.id = ${activityId}::uuid
            UNION ALL
            SELECT
              ${activityId}::uuid,
              activity_group_alias.group_id,
              'alias'::text,
              3
            FROM fitness.activity_group_alias
            WHERE activity_group_alias.user_id = ${this.userId}::uuid
              AND activity_group_alias.alias_id = ${activityId}::uuid
          )
          SELECT
            requested_id::text AS requested_id,
            resolved_group_id::text AS resolved_group_id,
            resolution_kind
          FROM identity_candidates
          ORDER BY precedence
          LIMIT 1`,
    );
    const resolution = rows[0] ?? null;
    this.#activityIdResolutions.set(activityId, resolution);
    if (resolution) {
      this.#activityIdResolutions.set(resolution.resolved_group_id, {
        requested_id: resolution.resolved_group_id,
        resolved_group_id: resolution.resolved_group_id,
        resolution_kind: "group",
      });
      logger.info("activity.id_resolved", {
        requestedActivityId: resolution.requested_id,
        resolvedGroupId: resolution.resolved_group_id,
        resolutionKind: resolution.resolution_kind,
      });
    }
    return resolution;
  }

  #attachResolution(row: ActivityRow, resolution: ActivityIdResolution): ActivityRow {
    return resolution.requested_id === resolution.resolved_group_id
      ? row
      : { ...row, resolved_from: resolution.requested_id };
  }

  async #findActiveByGroupId(groupId: string): Promise<ActivityRow | null> {
    const rows = await this.query(
      activityDetailRowSchema,
      sql`SELECT
            a.id,
            (${postgresActivityCalendarDate(sql`a`, this.timezone)})::text AS displayed_date,
            a.canonical_type,
            a.provider_type AS raw_type,
            a.modality::text AS modality,
            a.started_at::text AS started_at,
            a.ended_at::text AS ended_at,
            a.name,
            a.notes,
            a.perceived_exertion,
            a.provider_id,
            a.primary_activity_id::text AS primary_activity_id,
            a.primary_canonical_type::text AS primary_canonical_type,
            a.primary_provider_id,
            a.primary_source_name,
            a.origin_candidate_member_ids::text[] AS origin_candidate_member_ids,
            a.origin_evidence,
            a.timezone,
            a.start_utc_offset_minutes,
            a.end_utc_offset_minutes,
            a.local_time_source,
            a.raw->>'sourceName' AS subsource,
            a.source_providers,
            a.source_external_ids,
            a.absent_source_external_ids,
            a.member_activity_ids,
            EXISTS (
              SELECT 1
              FROM fitness.activity member
              WHERE member.id = ANY(a.member_activity_ids)
                AND member.user_id = a.user_id
                AND member.deleted_at IS NULL
                AND member.provider_absent_at IS NULL
                AND member.fit_recovery_error IS NOT NULL
            ) AS fit_recovery_error,
            NULL::double precision AS avg_hr,
            NULL::smallint AS max_hr,
            NULL::double precision AS avg_power,
            NULL::smallint AS max_power,
            NULL::double precision AS avg_speed,
            NULL::double precision AS max_speed,
            NULL::double precision AS avg_cadence,
            NULL::double precision AS total_distance,
            NULL::double precision AS elevation_gain_m,
            NULL::double precision AS elevation_loss_m,
            NULL::integer AS sample_count,
            NULL::text AS provider_absent_at
          FROM fitness.v_activity a
          WHERE a.id = ${groupId}::uuid
            AND a.user_id = ${this.userId}
            ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
    const hydratedRows = await withActivitySummaries(rows, this.#sensorStore, this.userId);
    const firstRow = hydratedRows[0];
    if (!firstRow) return null;
    const { member_activity_ids: _, ...activity } = firstRow;
    return activity;
  }

  async #findProviderAbsentByGroupId(groupId: string): Promise<ActivityRow | null> {
    const rows = await this.query(
      activityDetailRowSchema,
      sql`SELECT
            ${groupId}::uuid AS id,
            (${postgresActivityCalendarDate(sql`a`, this.timezone)})::text AS displayed_date,
            a.canonical_type,
            a.provider_type AS raw_type,
            a.modality::text AS modality,
            a.started_at::text AS started_at,
            a.ended_at::text AS ended_at,
            a.name,
            a.notes,
            a.perceived_exertion,
            a.provider_id,
            NULL::text AS primary_activity_id,
            NULL::text AS primary_canonical_type,
            NULL::text AS primary_provider_id,
            NULL::text AS primary_source_name,
            ARRAY(SELECT member.id::text FROM fitness.activity AS member
              WHERE member.user_id = a.user_id AND member.group_id = a.group_id
                AND member.deleted_at IS NULL ORDER BY member.id) AS origin_candidate_member_ids,
            '[]'::jsonb AS origin_evidence,
            CASE
              WHEN a.local_time_source IN ('provider_timezone', 'device_timezone', 'user_home_timezone')
              THEN a.timezone
              ELSE NULL
            END AS timezone,
            CASE
              WHEN a.local_time_source <> 'unknown' THEN a.start_utc_offset_minutes
              ELSE NULL
            END AS start_utc_offset_minutes,
            CASE
              WHEN a.local_time_source <> 'unknown' THEN a.end_utc_offset_minutes
              ELSE NULL
            END AS end_utc_offset_minutes,
            a.local_time_source,
            a.raw->>'sourceName' AS subsource,
            ARRAY[a.provider_id] AS source_providers,
            NULL::jsonb AS source_external_ids,
            CASE
              WHEN a.external_id IS NOT NULL AND a.external_id <> ''
              THEN jsonb_build_array(
                jsonb_build_object(
                  'providerId', a.provider_id,
                  'externalId', a.external_id,
                  'memberActivityId', a.id::text,
                  'providerAbsentAt', a.provider_absent_at,
                  'subsource', COALESCE(
                    NULLIF(trim(a.raw->>'sourceName'), ''),
                    NULLIF(trim(a.source_name), '')
                  )
                )
              )
              ELSE NULL
            END AS absent_source_external_ids,
            ARRAY[a.id]::uuid[] AS member_activity_ids,
            false AS fit_recovery_error,
            NULL::double precision AS avg_hr,
            NULL::smallint AS max_hr,
            NULL::double precision AS avg_power,
            NULL::smallint AS max_power,
            NULL::double precision AS avg_speed,
            NULL::double precision AS max_speed,
            NULL::double precision AS avg_cadence,
            NULL::double precision AS total_distance,
            NULL::double precision AS elevation_gain_m,
            NULL::double precision AS elevation_loss_m,
            NULL::integer AS sample_count,
            a.provider_absent_at::text AS provider_absent_at
          FROM fitness.activity a
          LEFT JOIN fitness.provider_priority pp ON pp.provider_id = a.provider_id
          LEFT JOIN LATERAL (
            SELECT dp2.priority
            FROM fitness.device_priority dp2
            WHERE dp2.provider_id = a.provider_id
              AND a.source_name LIKE dp2.source_name_pattern
            ORDER BY
              LENGTH(dp2.source_name_pattern) DESC,
              dp2.priority ASC,
              dp2.source_name_pattern ASC
            LIMIT 1
          ) dp ON true
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*) FILTER (
                WHERE s.set_type = 'working'
                  AND (
                    s.weight_kg IS NOT NULL OR s.reps IS NOT NULL
                    OR s.duration_seconds IS NOT NULL OR s.distance_meters IS NOT NULL
                  )
              ) AS complete_working_set_count,
              COUNT(*) AS set_count,
              COUNT(DISTINCT s.exercise_id) AS exercise_count
            FROM fitness.strength_set s
            WHERE s.activity_id = a.id
          ) payload ON true
          WHERE a.group_id = ${groupId}::uuid
            AND a.user_id = ${this.userId}::uuid
            AND a.provider_absent_at IS NOT NULL
            AND a.deleted_at IS NULL
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          ORDER BY
            payload.complete_working_set_count DESC,
            payload.set_count DESC,
            payload.exercise_count DESC,
            (a.canonical_type NOT IN ('cardio', 'other')) DESC,
            COALESCE(
              NULLIF(LOWER(TRIM(a.provider_type)), '') <> LOWER(a.canonical_type::text),
              false
            ) DESC,
            COALESCE(dp.priority, pp.priority, 100) ASC,
            a.id ASC
          LIMIT 1`,
    );
    const hydratedRows = await withActivitySummaries(rows, this.#sensorStore, this.userId);
    const firstRow = hydratedRows[0];
    if (!firstRow) return null;
    const { member_activity_ids: _, ...activity } = firstRow;
    return activity;
  }

  /** Downsampled metric stream for a single activity. */
  async getStream(
    activityId: string,
    maxPoints: number,
    sources?: ActivityMetricSourceSelection,
  ): Promise<StreamPoint[]> {
    const sensorStore = this.#requireSensorStore("activity streams");
    const window = await this.findSensorWindow(activityId);
    if (!window) throw activityNotFoundError();
    return this.#sensorRepository.getStream(sensorStore, window, maxPoints, sources);
  }

  async getMetricSources(activityId: string, responseVersion: 1 | 2 = 1) {
    const window = await this.findSensorWindow(activityId);
    if (!window) throw activityNotFoundError();
    const hardware = await this.#sensorRepository.getHardware(window);
    const store = this.#requireSensorStore("metric sources");
    return this.#sensorRepository.getMetricSources(store, window, hardware, responseVersion);
  }

  async getHardware(activityId: string) {
    const window = await this.findSensorWindow(activityId);
    if (!window) throw activityNotFoundError();
    return this.#sensorRepository.getHardware(window);
  }

  /** HR zone distribution for a single activity using the canonical Karvonen model. */
  async getHrZones(
    activityId: string,
    heartRateSourceId?: string,
  ): Promise<import("@dofek/zones/zones").ActivityHrZone[]> {
    const sensorStore = this.#requireSensorStore("heart-rate zones");
    const window = await this.findSensorWindow(activityId);
    if (!window) throw activityNotFoundError();
    return this.#sensorRepository.getHrZones(sensorStore, window, heartRateSourceId);
  }

  /** Cycling power zone distribution for a single activity using 7 zones relative to FTP. */
  async getPowerZones(
    activityId: string,
    ftp: number,
    powerSourceId?: string,
  ): Promise<import("@dofek/zones/zones").ActivityPowerZone[]> {
    const sensorStore = this.#requireSensorStore("power zones");
    const window = await this.findSensorWindow(activityId);
    if (!window) throw activityNotFoundError();
    return this.#sensorRepository.getPowerZones(sensorStore, window, ftp, powerSourceId);
  }

  #requireSensorStore(featureName: string): ActivitySensorStore {
    if (!this.#sensorStore) {
      throw new Error(`ClickHouse activity analytics store is required for ${featureName}`);
    }
    return this.#sensorStore;
  }

  /** Resolves any visible member ID to its owned canonical activity sensor window. */
  async findSensorWindow(activityId: string): Promise<ActivitySensorWindow | null> {
    const resolution = await this.#resolveActivityId(activityId);
    if (!resolution) return null;
    const rows = await this.query(
      activitySensorWindowRowSchema,
      sql`SELECT
            a.id,
            a.user_id,
            a.started_at::text AS started_at,
            a.ended_at::text AS ended_at,
            a.member_activity_ids,
            a.provider_type
          FROM fitness.v_activity a
          WHERE a.id = ${resolution.resolved_group_id}::uuid
            AND a.user_id = ${this.userId}
            ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      activityId: row.id,
      userId: row.user_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      memberActivityIds: row.member_activity_ids,
      providerType: row.provider_type,
    };
  }

  async getActivityMemberIds(activityId: string): Promise<string[] | null> {
    const window = await this.findSensorWindow(activityId);
    if (!window) return null;
    return window.memberActivityIds;
  }

  /** Delete an activity by ID. */
  async delete(activityId: string): Promise<void> {
    await this.bulkDelete([activityId]);
  }

  /** Clear provider tombstones so hidden activities become visible again. */
  async restoreProviderAbsent(
    activityIds: string[],
  ): Promise<{ restoredCount: number; memberActivityIds: string[] }> {
    const uniqueActivityIds = [...new Set(activityIds)];
    if (uniqueActivityIds.length === 0) {
      return { restoredCount: 0, memberActivityIds: [] };
    }

    const selectedIds = sql.join(
      uniqueActivityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    );

    const restoredRows = await this.query(
      z.object({ id: z.string() }),
      sql`WITH selected_groups AS (
            SELECT group_id AS id FROM fitness.activity
            WHERE user_id = ${this.userId}::uuid AND id IN (${selectedIds})
            UNION
            SELECT id FROM fitness.activity_group
            WHERE user_id = ${this.userId}::uuid AND id IN (${selectedIds})
            UNION
            SELECT group_id FROM fitness.activity_group_alias
            WHERE user_id = ${this.userId}::uuid AND alias_id IN (${selectedIds})
          )
          UPDATE fitness.activity
          SET provider_absent_at = NULL, absence_provider_id = NULL
          WHERE user_id = ${this.userId}::uuid
            AND provider_absent_at IS NOT NULL
            AND deleted_at IS NULL
            AND group_id IN (SELECT id FROM selected_groups)
          RETURNING id::text AS id`,
    );
    return {
      restoredCount: restoredRows.length,
      memberActivityIds: restoredRows.map((row) => row.id),
    };
  }

  /** Delete activities by visible activity IDs, including all members of matching deduped groups. */
  async bulkDelete(
    activityIds: string[],
  ): Promise<{ deletedCount: number; memberActivityIds: string[] }> {
    const uniqueActivityIds = [...new Set(activityIds)];
    if (uniqueActivityIds.length === 0) {
      return { deletedCount: 0, memberActivityIds: [] };
    }

    const memberRows = await this.query(
      z.object({ member_activity_id: z.string() }),
      sql`SELECT DISTINCT member_rows.member_activity_id::text AS member_activity_id
          FROM fitness.v_activity a
          CROSS JOIN LATERAL UNNEST(a.member_activity_ids) AS member_rows(member_activity_id)
          WHERE a.user_id = ${this.userId}::uuid
            AND (
              a.id IN (${sql.join(
                uniqueActivityIds.map((selectedActivityId) => sql`${selectedActivityId}::uuid`),
                sql`, `,
              )})
              OR a.member_activity_ids && ARRAY[${sql.join(
                uniqueActivityIds.map((selectedActivityId) => sql`${selectedActivityId}::uuid`),
                sql`, `,
              )}]::uuid[]
              OR EXISTS (
                SELECT 1
                FROM fitness.activity_group_alias selected_alias
                WHERE selected_alias.user_id = ${this.userId}::uuid
                  AND selected_alias.alias_id IN (${sql.join(
                    uniqueActivityIds.map((selectedActivityId) => sql`${selectedActivityId}::uuid`),
                    sql`, `,
                  )})
                  AND selected_alias.group_id = a.id
              )
            )`,
    );
    const memberActivityIds = memberRows.map((row) => row.member_activity_id);

    if (memberActivityIds.length > 0) {
      await this.db.execute(sql`
        UPDATE fitness.climbing_log_entry
        SET activity_id = NULL
        WHERE user_id = ${this.userId}::uuid
          AND activity_id IN (${sql.join(
            memberActivityIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
      `);
      await this.db.execute(sql`
        UPDATE fitness.activity
        SET deleted_at = NOW()
        WHERE id IN (${sql.join(
          memberActivityIds.map((memberActivityId) => sql`${memberActivityId}::uuid`),
          sql`, `,
        )})
          AND user_id = ${this.userId}::uuid
          AND deleted_at IS NULL
      `);
    }
    await retireActivityImages(this.db, { userId: this.userId, activityIds: memberActivityIds });
    return { deletedCount: uniqueActivityIds.length, memberActivityIds };
  }

  /** Merge visible activity groups while preserving their provider source rows. */
  async mergeActivities(
    activityIds: string[],
  ): Promise<{ groupId: string; memberActivityIds: string[]; affectedGroupIds: string[] }> {
    const ids = [...new Set(activityIds)];
    await this.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-groups:${this.userId}`}, 0))`,
    );
    const selected = await this.query(
      z.object({ id: z.string(), canonical_type: z.string(), started_at: timestampStringSchema }),
      sql`SELECT id::text AS id, canonical_type::text AS canonical_type, started_at::text AS started_at
        FROM fitness.v_activity WHERE user_id = ${this.userId}::uuid
          AND id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) ${this.timestampAccessPredicate(sql`started_at`)}`,
    );
    if (selected.length !== ids.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Some selected activities are no longer visible. Refresh the activity list and try again.",
      });
    }
    if (new Set(selected.map((row) => row.canonical_type)).size !== 1) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Selected activities must have the same type.",
      });
    }
    const retained = [...selected].sort(
      (a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id),
    )[0];
    if (!retained)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Select at least two activities to merge.",
      });
    const groupIds = selected.map((row) => row.id);
    const members = await this.query(
      z.object({ id: z.string() }),
      sql`SELECT id::text AS id
      FROM fitness.activity WHERE user_id = ${this.userId}::uuid
        AND group_id IN (${sql.join(
          groupIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
    );
    const memberActivityIds = members.map((row) => row.id);
    await this.db.execute(sql`UPDATE fitness.activity SET group_id = ${retained.id}::uuid
      WHERE user_id = ${this.userId}::uuid
        AND group_id IN (${sql.join(
          groupIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        AND group_id <> ${retained.id}::uuid`);
    await this.db.execute(sql`UPDATE fitness.activity_group SET manual_merge = true
      WHERE user_id = ${this.userId}::uuid AND id = ${retained.id}::uuid`);
    for (const retiredId of groupIds.filter((id) => id !== retained.id)) {
      await this.db.execute(sql`UPDATE fitness.activity_group_alias SET group_id = ${retained.id}::uuid
        WHERE user_id = ${this.userId}::uuid AND group_id = ${retiredId}::uuid`);
      await this.db.execute(sql`INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason)
        VALUES (${retiredId}::uuid, ${retained.id}::uuid, ${this.userId}::uuid, 'merge')
        ON CONFLICT (alias_id) DO UPDATE SET group_id = excluded.group_id`);
    }
    return { groupId: retained.id, memberActivityIds, affectedGroupIds: groupIds };
  }
}
