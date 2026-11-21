import type { Database } from "dofek/db";
import { z } from "zod";
import {
  type AccessWindow,
  clickHouseAccessParams,
  clickHouseAccessPredicate,
} from "../billing/entitlement.ts";
import {
  type CyclingPowerProfile,
  cyclingPowerProfileDurations,
} from "../contracts/cycling-power-profile.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  curveColumns,
  curveRowSchema,
  toCyclingPowerCurveEffort,
} from "./cycling-power-curve-repository.ts";
import { selectNearbyWeight } from "./nearby-weight.ts";
import { loadDirectWeightObservations } from "./nearby-weight-repository.ts";
import { SportSettingsRepository } from "./sport-settings-repository.ts";

const profileCurveRowSchema = curveRowSchema.extend({
  activity_name: z.string().nullable(),
  modality: z.string().nullable(),
  power_measurement_kind: z.enum(["direct", "unknown"]),
});

interface ProfileRange {
  startDate: string | null;
  endDate: string;
}

function profileCurveQuery(range: ProfileRange, accessWindow: AccessWindow | undefined): string {
  const activityDate = "toDate(toTimeZone(activity.started_at, {timezone:String}))";
  return `/* cycling-profile:efforts */
    WITH candidates AS (
      SELECT ${curveColumns("curve", "activity", "activity")},
        activity.name AS activity_name,
        nullIf(activity.modality, '') AS modality
      FROM analytics.activity_power_curve AS curve FINAL
      INNER JOIN analytics.deduped_activities AS activity FINAL
        ON activity.activity_id = curve.activity_id AND activity.user_id = curve.user_id
      WHERE activity.user_id = {userId:UUID} AND activity.is_deleted = 0
        AND activity.canonical_type = 'cycling' AND activity.ended_at IS NOT NULL
        AND ${activityDate} <= toDate({endDate:String})
        ${range.startDate === null ? "" : `AND ${activityDate} >= toDate({startDate:String})`}
        ${clickHouseAccessPredicate(accessWindow, "activity.started_at")}
        AND curve.is_deleted = 0
        AND curve.duration_seconds IN ({durations:Array(UInt32)})
    ),
    contributing_strava_members AS (
      SELECT DISTINCT activity_id, arrayJoin(member_activity_ids) AS member_id
      FROM candidates
      WHERE has(source_providers, 'strava')
    ),
    active_strava_claims AS (
      SELECT activity_id,
        JSONExtract(ifNull(raw, '{}'), 'device_watts', 'Nullable(Bool)') AS device_watts
      FROM analytics.activity_source_records FINAL
      WHERE user_id = {userId:UUID} AND provider_id = 'strava' AND is_deleted = 0
        AND activity_id IN (SELECT member_id FROM contributing_strava_members)
    ),
    strava_evidence AS (
      SELECT member.activity_id AS activity_id, count() AS member_count,
        countIf(claim.device_watts = true) AS direct_count,
        countIf(claim.device_watts = false) AS estimated_count
      FROM contributing_strava_members AS member
      INNER JOIN active_strava_claims AS claim ON claim.activity_id = member.member_id
      GROUP BY member.activity_id
    ),
    assessed AS (
      SELECT candidate.*,
        multiIf(
          candidate.power_measurement_kind = 'estimated'
            OR (has(candidate.source_providers, 'strava') AND evidence.estimated_count > 0),
          'estimated',
          candidate.power_measurement_kind = 'direct'
            OR (candidate.source_providers = ['strava']
              AND evidence.member_count = 1 AND evidence.direct_count = 1),
          'direct',
          'unknown'
        ) AS assessed_kind
      FROM candidates AS candidate
      LEFT JOIN strava_evidence AS evidence ON evidence.activity_id = candidate.activity_id
    )
    SELECT * EXCEPT (power_measurement_kind, assessed_kind),
      assessed_kind AS power_measurement_kind
    FROM assessed
    WHERE assessed_kind != 'estimated'
    QUALIFY row_number() OVER (
      PARTITION BY duration_seconds
      ORDER BY (assessed_kind = 'direct') DESC, best_power DESC, started_at DESC, activity_id ASC
    ) = 1
    ORDER BY duration_seconds
    SETTINGS prefer_column_name_to_alias = 1`;
}

export class CyclingPowerProfileRepository {
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

  async read(range: ProfileRange): Promise<CyclingPowerProfile> {
    const [rows, settings] = await Promise.all([
      this.#store.query(profileCurveRowSchema, profileCurveQuery(range, this.#accessWindow), {
        userId: this.#userId,
        timezone: this.#timezone,
        durations: cyclingPowerProfileDurations,
        endDate: range.endDate,
        ...(range.startDate === null ? {} : { startDate: range.startDate }),
        ...clickHouseAccessParams(this.#accessWindow, this.#timezone),
      }),
      new SportSettingsRepository(this.#db, this.#userId, this.#timezone).getBySport(
        "cycling",
        range.endDate,
      ),
    ]);
    const ftp = settings?.ftp ?? null;
    const firstWeightDate = rows.reduce(
      (earliest, row) => (row.activity_date < earliest ? row.activity_date : earliest),
      range.endDate,
    );
    const weights =
      rows.length || ftp !== null
        ? await loadDirectWeightObservations(
            this.#store,
            this.#userId,
            this.#timezone,
            firstWeightDate,
            range.endDate,
            { includeRecordId: true, accessWindow: this.#accessWindow },
          )
        : [];
    const thresholdWeight = ftp === null ? null : selectNearbyWeight(range.endDate, weights);
    const thresholdWeightKg = thresholdWeight?.value_kg;
    const byDuration = new Map(rows.map((row) => [row.duration_seconds, row]));
    return {
      range: { start_date: range.startDate, end_date: range.endDate, timezone: this.#timezone },
      maximal_test_status: "unverified",
      efforts: cyclingPowerProfileDurations.map((duration) => {
        const row = byDuration.get(duration);
        return {
          duration_seconds: duration,
          effort: row
            ? {
                ...toCyclingPowerCurveEffort(row, selectNearbyWeight(row.activity_date, weights)),
                activity_name: row.activity_name,
                modality: row.modality,
                end_offset_seconds:
                  row.start_offset_seconds === null ? null : row.start_offset_seconds + duration,
              }
            : null,
        };
      }),
      threshold: {
        watts: ftp,
        watts_per_kg:
          ftp === null || thresholdWeightKg == null
            ? null
            : Math.round((ftp / thresholdWeightKg) * 1000) / 1000,
        effective_from: settings?.effectiveFrom ?? null,
        source_record_id: settings?.id ?? null,
        method: "configured",
        unavailable_reason:
          ftp === null ? "No cycling FTP is configured for the selected end date." : null,
        weight: thresholdWeight,
      },
    };
  }
}
