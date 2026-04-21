import {
  computePolarizationIndex,
  POLARIZATION_ZONES,
  ZONE_BOUNDARIES_HRR,
} from "@dofek/zones/zones";
import * as telemetry from "dofek/telemetry";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { restingHeartRateLateral } from "../lib/sql-fragments.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AerobicEfficiencyActivity {
  date: string;
  activityType: string;
  name: string;
  avgPowerZ2: number;
  avgHrZ2: number;
  efficiencyFactor: number;
  z2Samples: number;
}

export interface AerobicEfficiencyResult {
  maxHr: number | null;
  activities: AerobicEfficiencyActivity[];
}

export interface AerobicDecouplingActivity {
  date: string;
  activityType: string;
  name: string;
  firstHalfRatio: number;
  secondHalfRatio: number;
  decouplingPct: number;
  totalSamples: number;
}

export interface PolarizationWeek {
  week: string;
  z1Seconds: number;
  z2Seconds: number;
  z3Seconds: number;
  polarizationIndex: number | null;
}

export interface PolarizationTrendResult {
  maxHr: number | null;
  weeks: PolarizationWeek[];
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const efficiencyRowSchema = z.object({
  max_hr: z.coerce.number(),
  date: dateStringSchema,
  activity_type: z.string(),
  name: z.string(),
  avg_power_z2: z.coerce.number(),
  avg_hr_z2: z.coerce.number(),
  efficiency_factor: z.coerce.number(),
  z2_samples: z.coerce.number(),
});

const decouplingRowSchema = z.object({
  date: dateStringSchema,
  activity_type: z.string(),
  name: z.string(),
  first_half_ratio: z.coerce.number(),
  second_half_ratio: z.coerce.number(),
  decoupling_pct: z.coerce.number(),
  total_samples: z.coerce.number(),
});

const polarizationRowSchema = z.object({
  max_hr: z.coerce.number(),
  week: dateStringSchema,
  z1_seconds: z.coerce.number(),
  z2_seconds: z.coerce.number(),
  z3_seconds: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for aerobic efficiency, decoupling, and polarization metrics. */
export class EfficiencyRepository extends BaseRepository {
  /**
   * Aerobic Efficiency (Efficiency Factor) per activity.
   * EF = avg power in Z2 / avg HR in Z2, where Z2 = 60-70% HRR (Karvonen).
   * Only includes activities with at least 5 minutes (300 samples) of Z2 data.
   */
  async getAerobicEfficiency(days: number): Promise<AerobicEfficiencyResult> {
    const rows = await this.query(
      efficiencyRowSchema,
      sql`SELECT
            up.max_hr,
            (a.started_at AT TIME ZONE ${this.timezone})::date AS date,
            a.activity_type,
            a.name,
            ROUND(AVG(pwr.scalar)::numeric, 1) AS avg_power_z2,
            ROUND(AVG(hr.scalar)::numeric, 1) AS avg_hr_z2,
            ROUND((AVG(pwr.scalar)::numeric / NULLIF(AVG(hr.scalar), 0))::numeric, 3) AS efficiency_factor,
            COUNT(*)::int AS z2_samples
          FROM fitness.user_profile up
          JOIN fitness.v_activity a ON a.user_id = up.id
          JOIN fitness.deduped_sensor hr ON hr.activity_id = a.id AND hr.channel = 'heart_rate'
          JOIN fitness.deduped_sensor pwr ON pwr.activity_id = a.id AND pwr.channel = 'power'
            AND pwr.recorded_at = hr.recorded_at
          JOIN ${restingHeartRateLateral(sql`up.id`, sql`(a.started_at AT TIME ZONE ${this.timezone})::date`)}
          WHERE up.id = ${this.userId}
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ${enduranceTypeFilter("a")}
            AND up.max_hr IS NOT NULL
            AND hr.scalar >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[0]}::numeric
            AND hr.scalar <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[1]}::numeric
            AND pwr.scalar > 0
          GROUP BY a.id, a.started_at, a.activity_type, a.name, up.max_hr
          HAVING COUNT(*) >= 300
          ORDER BY a.started_at`,
    );

    if (rows.length === 0) {
      this.#logEmptyAerobicEfficiency(days).catch((error) => {
        telemetry.captureException(error);
      });
    }

    const maxHr = rows.length > 0 ? Number(rows[0]?.max_hr) : null;

    return {
      maxHr,
      activities: rows.map((row) => ({
        date: String(row.date),
        activityType: String(row.activity_type),
        name: String(row.name),
        avgPowerZ2: Number(row.avg_power_z2),
        avgHrZ2: Number(row.avg_hr_z2),
        efficiencyFactor: Number(row.efficiency_factor),
        z2Samples: Number(row.z2_samples),
      })),
    };
  }

  /** Log diagnostic info when aerobic efficiency returns no results. */
  async #logEmptyAerobicEfficiency(days: number): Promise<void> {
    const diagnosticSchema = z.object({
      max_hr: z.coerce.number().nullable(),
      has_resting_hr: z.coerce.boolean(),
      endurance_activities: z.coerce.number(),
      activities_with_power: z.coerce.number(),
      activities_with_hr: z.coerce.number(),
      activities_with_both: z.coerce.number(),
      max_z2_samples: z.coerce.number(),
    });

    const diagnosticRows = await executeWithSchema(
      this.db,
      diagnosticSchema,
      sql`SELECT
            up.max_hr,
            EXISTS (
              SELECT 1 FROM fitness.v_daily_metrics dm
              WHERE dm.user_id = up.id AND dm.resting_hr IS NOT NULL
            ) AS has_resting_hr,
            (SELECT COUNT(DISTINCT a.id)
             FROM fitness.v_activity a
             WHERE a.user_id = up.id
               AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
               AND ${enduranceTypeFilter("a")}
            )::int AS endurance_activities,
            (SELECT COUNT(DISTINCT ds.activity_id)
             FROM fitness.deduped_sensor ds
             JOIN fitness.v_activity a ON a.id = ds.activity_id
             WHERE a.user_id = up.id
               AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
               AND ${enduranceTypeFilter("a")}
               AND ds.channel = 'power'
               AND ds.scalar > 0
            )::int AS activities_with_power,
            (SELECT COUNT(DISTINCT ds.activity_id)
             FROM fitness.deduped_sensor ds
             JOIN fitness.v_activity a ON a.id = ds.activity_id
             WHERE a.user_id = up.id
               AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
               AND ${enduranceTypeFilter("a")}
               AND ds.channel = 'heart_rate'
               AND ds.scalar IS NOT NULL
            )::int AS activities_with_hr,
            (SELECT COUNT(*)
             FROM (
               SELECT DISTINCT pwr.activity_id
               FROM fitness.deduped_sensor pwr
               JOIN fitness.deduped_sensor hr
                 ON hr.activity_id = pwr.activity_id
                AND hr.recorded_at = pwr.recorded_at
                AND hr.channel = 'heart_rate'
                AND hr.scalar IS NOT NULL
               JOIN fitness.v_activity a ON a.id = pwr.activity_id
               WHERE a.user_id = up.id
                 AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
                 AND ${enduranceTypeFilter("a")}
                 AND pwr.channel = 'power'
                 AND pwr.scalar > 0
             ) matched_samples
            )::int AS activities_with_both,
            COALESCE((
              SELECT MAX(z2_count)
              FROM (
                SELECT COUNT(DISTINCT hr.recorded_at)::int AS z2_count
                FROM fitness.deduped_sensor hr
                JOIN fitness.v_activity a ON a.id = hr.activity_id
                JOIN LATERAL (
                  SELECT dm.resting_hr
                  FROM fitness.v_daily_metrics dm
                  WHERE dm.user_id = up.id
                    AND dm.date <= (a.started_at AT TIME ZONE ${this.timezone})::date
                    AND dm.resting_hr IS NOT NULL
                  ORDER BY dm.date DESC
                  LIMIT 1
                ) rhr ON true
                WHERE a.user_id = up.id
                  AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
                  AND hr.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
                  AND ${enduranceTypeFilter("a")}
                  AND up.max_hr IS NOT NULL
                  AND hr.channel = 'heart_rate'
                  AND hr.scalar >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[0]}::numeric
                  AND hr.scalar <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[1]}::numeric
                  AND EXISTS (
                    SELECT 1
                    FROM fitness.deduped_sensor pwr
                    WHERE pwr.activity_id = hr.activity_id
                      AND pwr.recorded_at = hr.recorded_at
                      AND pwr.channel = 'power'
                      AND pwr.scalar > 0
                  )
                GROUP BY a.id
              ) sub
            ), 0)::int AS max_z2_samples
          FROM fitness.user_profile up
          WHERE up.id = ${this.userId}`,
    );

    const diag = diagnosticRows[0];
    if (diag) {
      logger.warn(
        `[aerobicEfficiency] Empty result for user=${this.userId} days=${days}: ` +
          `max_hr=${diag.max_hr}, has_resting_hr=${diag.has_resting_hr}, ` +
          `endurance_activities=${diag.endurance_activities}, ` +
          `with_power=${diag.activities_with_power}, with_hr=${diag.activities_with_hr}, ` +
          `with_both=${diag.activities_with_both}, max_z2_samples=${diag.max_z2_samples}`,
      );
    }
  }

  /**
   * Aerobic Decoupling per activity.
   * Compares power:HR ratio in first half vs second half of each activity.
   * Decoupling < 5% indicates a strong aerobic base.
   */
  async getAerobicDecoupling(days: number): Promise<AerobicDecouplingActivity[]> {
    const rows = await this.query(
      decouplingRowSchema,
      sql`WITH activity_halves AS (
            SELECT
              pwr.activity_id,
              pwr.scalar AS power,
              hr.scalar AS heart_rate,
              NTILE(2) OVER (PARTITION BY pwr.activity_id ORDER BY pwr.recorded_at) AS half
            FROM fitness.deduped_sensor pwr
            JOIN fitness.deduped_sensor hr
              ON hr.activity_id = pwr.activity_id
              AND hr.recorded_at = pwr.recorded_at
              AND hr.channel = 'heart_rate'
            JOIN fitness.v_activity a ON a.id = pwr.activity_id
            WHERE a.user_id = ${this.userId}
              AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
              AND ${enduranceTypeFilter("a")}
              AND pwr.channel = 'power'
              AND pwr.scalar > 0
              AND hr.scalar > 0
          ),
          half_ratios AS (
            SELECT
              activity_id,
              ROUND(
                (AVG(power) FILTER (WHERE half = 1))::numeric /
                NULLIF(AVG(heart_rate) FILTER (WHERE half = 1), 0)::numeric, 3
              ) AS first_half_ratio,
              ROUND(
                (AVG(power) FILTER (WHERE half = 2))::numeric /
                NULLIF(AVG(heart_rate) FILTER (WHERE half = 2), 0)::numeric, 3
              ) AS second_half_ratio,
              COUNT(*)::int AS total_samples
            FROM activity_halves
            GROUP BY activity_id
            HAVING COUNT(*) >= 600
          )
          SELECT
            (a.started_at AT TIME ZONE ${this.timezone})::date AS date,
            a.activity_type,
            a.name,
            hr.first_half_ratio,
            hr.second_half_ratio,
            ROUND(
              ((hr.first_half_ratio - hr.second_half_ratio) / NULLIF(hr.first_half_ratio, 0) * 100)::numeric, 2
            ) AS decoupling_pct,
            hr.total_samples
          FROM half_ratios hr
          JOIN fitness.v_activity a ON a.id = hr.activity_id
          WHERE hr.first_half_ratio > 0 AND hr.second_half_ratio > 0
          ORDER BY a.started_at`,
    );

    return rows.map((row) => ({
      date: String(row.date),
      activityType: String(row.activity_type),
      name: String(row.name),
      firstHalfRatio: Number(row.first_half_ratio),
      secondHalfRatio: Number(row.second_half_ratio),
      decouplingPct: Number(row.decoupling_pct),
      totalSamples: Number(row.total_samples),
    }));
  }

  /**
   * Polarization Index trend per week using Treff 3-zone model.
   * PI = log10((f1 / (f2 * f3)) * 100) where f = fraction of total training time.
   * PI > 2.0 indicates a well-polarized training distribution.
   */
  async getPolarizationTrend(days: number): Promise<PolarizationTrendResult> {
    const rows = await this.query(
      polarizationRowSchema,
      sql`SELECT
            up.max_hr,
            date_trunc('week', (a.started_at AT TIME ZONE ${this.timezone})::date)::date AS week,
            COUNT(*) FILTER (WHERE ds.scalar < up.max_hr * ${POLARIZATION_ZONES[1]?.minPctHrmax}::numeric)::int AS z1_seconds,
            COUNT(*) FILTER (WHERE ds.scalar >= up.max_hr * ${POLARIZATION_ZONES[1]?.minPctHrmax}::numeric
                              AND ds.scalar <  up.max_hr * ${POLARIZATION_ZONES[2]?.minPctHrmax}::numeric)::int AS z2_seconds,
            COUNT(*) FILTER (WHERE ds.scalar >= up.max_hr * ${POLARIZATION_ZONES[2]?.minPctHrmax}::numeric)::int AS z3_seconds
          FROM fitness.user_profile up
          JOIN fitness.v_activity a ON a.user_id = up.id
          JOIN fitness.deduped_sensor ds ON ds.activity_id = a.id AND ds.channel = 'heart_rate'
          WHERE up.id = ${this.userId}
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ${enduranceTypeFilter("a")}
            AND up.max_hr IS NOT NULL
          GROUP BY up.max_hr, 2
          ORDER BY week`,
    );

    const maxHr = rows.length > 0 ? Number(rows[0]?.max_hr) : null;

    const weeks: PolarizationWeek[] = rows.map((row) => {
      const z1 = Number(row.z1_seconds);
      const z2 = Number(row.z2_seconds);
      const z3 = Number(row.z3_seconds);

      return {
        week: String(row.week),
        z1Seconds: z1,
        z2Seconds: z2,
        z3Seconds: z3,
        polarizationIndex: computePolarizationIndex(z1, z2, z3),
      };
    });

    return { maxHr, weeks };
  }
}
