import { intensityFactor, powerTrainingStress } from "@dofek/cycling-power/power";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { CyclingThresholdEvidence } from "../contracts/cycling-threshold.ts";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { postgresActivityLocalDate } from "./activity-local-date.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { SportSettingsRepository } from "./sport-settings-repository.ts";

function activityAccessPredicate(window: AccessWindow | undefined, column: SQL, timezone: string) {
  if (!window || window.kind === "full") return sql``;
  const instant = (bound: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(bound)
      ? sql`(${bound}::date::timestamp without time zone AT TIME ZONE ${timezone})`
      : sql`${bound}::timestamptz`;
  return sql`AND ${column} >= ${instant(window.startDate)}
    AND ${column} < ${instant(window.endDateExclusive)}`;
}

const activitySchema = z.object({
  requested_id: z.string().uuid(),
  activity_id: z.string().uuid(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  activity_date: dateStringSchema,
  canonical_type: z.string(),
  ftp: z.coerce.number().positive().nullable(),
  threshold_effective_from: dateStringSchema.nullable(),
  threshold_source_record_id: z.string().uuid().nullable(),
});
const npSchema = z.object({
  activity_id: z.string().uuid(),
  normalized_power: z.coerce.number().nonnegative().nullable(),
  power_sample_count: z.coerce.number().int().nonnegative(),
});

export interface CyclingActivityPowerMetrics {
  activity_id: string;
  started_at: string;
  ended_at: string | null;
  activity_date: string;
  canonical_type: string;
  normalized_power: number | null;
  power_sample_count: number | null;
  ftp: number | null;
  power_tss: number | null;
  intensity_factor: number | null;
  threshold: {
    value: number | null;
    unit: "watt";
    effective_from: string;
    source_record_id: string;
    kind: "configured";
  } | null;
}

export type { CyclingThresholdEvidence } from "../contracts/cycling-threshold.ts";

export function cyclingThresholdEvidenceFromMetrics(
  metrics: CyclingActivityPowerMetrics | null,
): CyclingThresholdEvidence {
  return {
    value: metrics?.ftp ?? null,
    unit: "watt",
    method: "configured",
    effective_from: metrics?.threshold?.effective_from ?? null,
    source_record_id: metrics?.threshold?.source_record_id ?? null,
    unavailable_reason:
      metrics?.ftp == null
        ? "No configured cycling FTP is effective for this activity date."
        : null,
  };
}

/** Resolves dated manual FTP in Postgres and NP from the serving projection in one batch each. */
export class CyclingThresholdRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow | undefined;

  constructor(
    db: Pick<Database, "execute">,
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
    accessWindow?: AccessWindow,
  ) {
    this.#db = db;
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#accessWindow = accessWindow;
  }

  async getCurrent(): Promise<CyclingThresholdEvidence> {
    const row = await new SportSettingsRepository(
      this.#db,
      this.#userId,
      this.#timezone,
    ).getBySport("cycling");
    return {
      value: row?.ftp ?? null,
      unit: "watt",
      method: "configured",
      effective_from: row?.effectiveFrom ?? null,
      source_record_id: row?.id ?? null,
      unavailable_reason: row?.ftp == null ? "No configured cycling FTP is effective today." : null,
    };
  }

  async getForActivities(activityIds: string[]): Promise<Map<string, CyclingActivityPowerMetrics>> {
    if (activityIds.length === 0) return new Map();
    const uniqueActivityIds = [...new Set(activityIds)];
    const requestedIds = sql.join(
      uniqueActivityIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const canonicalLocalDate = postgresActivityLocalDate(sql`canonical_activity`, this.#timezone);
    const absentLocalDate = postgresActivityLocalDate(sql`absent_activity`, this.#timezone);
    const activities = await executeWithSchema(
      this.#db,
      activitySchema,
      sql`
        WITH requested AS (SELECT ARRAY[${requestedIds}]::uuid[] AS ids),
        visible_activity AS (
          SELECT requested_input.requested_id, canonical_activity.id, canonical_activity.user_id,
            canonical_activity.started_at, canonical_activity.ended_at,
            ${canonicalLocalDate} AS activity_date, canonical_activity.canonical_type
          FROM fitness.v_activity AS canonical_activity
          CROSS JOIN requested
          CROSS JOIN LATERAL unnest(requested.ids) AS requested_input(requested_id)
          WHERE canonical_activity.user_id = ${this.#userId}::uuid
            AND (canonical_activity.id = requested_input.requested_id
              OR requested_input.requested_id = ANY(canonical_activity.member_activity_ids))
            AND NOT EXISTS (
              SELECT 1 FROM fitness.activity AS withdrawn
              WHERE withdrawn.user_id = ${this.#userId}::uuid
                AND withdrawn.id = requested_input.requested_id
                AND withdrawn.provider_absent_at IS NOT NULL
                AND withdrawn.deleted_at IS NULL
            )
          UNION
          SELECT absent_activity.id AS requested_id, absent_activity.id, absent_activity.user_id,
            absent_activity.started_at, absent_activity.ended_at,
            ${absentLocalDate} AS activity_date, absent_activity.canonical_type
          FROM fitness.activity AS absent_activity
          CROSS JOIN requested
          WHERE absent_activity.user_id = ${this.#userId}::uuid
            AND absent_activity.provider_absent_at IS NOT NULL
            AND absent_activity.deleted_at IS NULL
            AND absent_activity.id = ANY(requested.ids)
        )
        SELECT activity.requested_id::text AS requested_id,
          activity.id::text AS activity_id,
          activity.started_at, activity.ended_at,
          activity.activity_date,
          activity.canonical_type,
          settings.ftp,
          settings.effective_from AS threshold_effective_from,
          settings.id::text AS threshold_source_record_id
        FROM visible_activity AS activity
        LEFT JOIN LATERAL (
          SELECT id, ftp, effective_from
          FROM fitness.sport_settings
          WHERE user_id = activity.user_id AND sport = 'cycling'
            AND effective_from <= activity.activity_date
          ORDER BY effective_from DESC
          LIMIT 1
        ) AS settings ON true
        WHERE activity.user_id = ${this.#userId}::uuid
          ${activityAccessPredicate(this.#accessWindow, sql`activity.started_at`, this.#timezone)}
      `,
    );
    if (activities.length === 0) return new Map();

    const normalizedPower = await this.#store.query(
      npSchema,
      `SELECT toString(metrics.activity_id) AS activity_id, metrics.normalized_power,
          metrics.power_sample_count
        FROM analytics.cycling_activity_power_metrics AS metrics
        WHERE metrics.user_id = {userId:UUID}
          AND metrics.activity_id IN {activityIds:Array(UUID)}
      `,
      {
        userId: this.#userId,
        activityIds: activities.map((activity) => activity.activity_id),
      },
    );
    const npById = new Map(normalizedPower.map((row) => [row.activity_id, row]));
    const cyclingTypes = new Set<string>(CYCLING_ACTIVITY_TYPES);
    return new Map(
      activities.map((activity) => {
        const np = npById.get(activity.activity_id);
        const isCycling = cyclingTypes.has(activity.canonical_type);
        const ftp = isCycling ? activity.ftp : null;
        const durationSeconds = activity.ended_at
          ? (Date.parse(activity.ended_at) - Date.parse(activity.started_at)) / 1_000
          : 0;
        const threshold =
          isCycling && activity.threshold_effective_from && activity.threshold_source_record_id
            ? {
                value: ftp,
                unit: "watt" as const,
                effective_from: activity.threshold_effective_from,
                source_record_id: activity.threshold_source_record_id,
                kind: "configured" as const,
              }
            : null;
        return [
          activity.requested_id,
          {
            activity_id: activity.activity_id,
            started_at: activity.started_at,
            ended_at: activity.ended_at,
            activity_date: activity.activity_date,
            canonical_type: activity.canonical_type,
            normalized_power: np?.normalized_power ?? null,
            power_sample_count: np?.power_sample_count ?? null,
            ftp,
            intensity_factor: isCycling ? intensityFactor(np?.normalized_power ?? null, ftp) : null,
            power_tss: isCycling
              ? powerTrainingStress(np?.normalized_power ?? null, ftp, durationSeconds)
              : null,
            threshold,
          },
        ] as const;
      }),
    );
  }
}
