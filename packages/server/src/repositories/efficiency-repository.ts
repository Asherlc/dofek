import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { computePolarizationIndex, HEART_RATE_ZONES, POLARIZATION_ZONES } from "@dofek/zones/zones";
import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { restingHeartRateClickHouseCte } from "./resting-heart-rate-query.ts";

const ENDURANCE_TYPES: string[] = [...ENDURANCE_ACTIVITY_TYPES];

function requireHeartRateZone(zoneNumber: number) {
  const zone = HEART_RATE_ZONES.find((zoneDefinition) => zoneDefinition.zone === zoneNumber);
  if (!zone) {
    throw new Error(`Heart-rate zone ${zoneNumber} definition is required`);
  }
  return zone;
}

function requirePolarizationZone(zoneNumber: number) {
  const zone = POLARIZATION_ZONES.find((zoneDefinition) => zoneDefinition.zone === zoneNumber);
  if (!zone) {
    throw new Error(`Polarization zone ${zoneNumber} definition is required`);
  }
  return zone;
}

const aerobicEfficiencyZone = requireHeartRateZone(2);
const polarizationZone2 = requirePolarizationZone(2);
const polarizationZone3 = requirePolarizationZone(3);

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
  date: z.string(),
  activity_type: z.string(),
  name: z.string().nullable(),
  avg_power_z2: z.coerce.number(),
  avg_hr_z2: z.coerce.number(),
  efficiency_factor: z.coerce.number(),
  z2_samples: z.coerce.number(),
});

const decouplingRowSchema = z.object({
  date: z.string(),
  activity_type: z.string(),
  name: z.string().nullable(),
  first_half_ratio: z.coerce.number(),
  second_half_ratio: z.coerce.number(),
  decoupling_pct: z.coerce.number(),
  total_samples: z.coerce.number(),
});

const polarizationRowSchema = z.object({
  max_hr: z.coerce.number(),
  week: z.string(),
  z1_seconds: z.coerce.number(),
  z2_seconds: z.coerce.number(),
  z3_seconds: z.coerce.number(),
});

const aerobicEfficiencyDiagnosticSchema = z.object({
  max_hr: z.coerce.number().nullable(),
  endurance_activities: z.coerce.number(),
  activities_with_power: z.coerce.number(),
  activities_with_hr: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for aerobic efficiency, decoupling, and polarization metrics. */
export class EfficiencyRepository extends BaseRepository {
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
    accessWindow?: AccessWindow,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#sensorStore = sensorStore;
  }

  /**
   * Aerobic Efficiency (Efficiency Factor) per activity.
   * EF = avg power in Z2 / avg HR in Z2, where Z2 = 60-70% HRR (Karvonen).
   * Only includes activities with at least 5 minutes (300 samples) of Z2 data.
   */
  async getAerobicEfficiency(days: number): Promise<AerobicEfficiencyResult> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.#sensorStore.query(
      efficiencyRowSchema,
      `WITH ${restingHeartRateClickHouseCte()},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
          a.activity_type AS activity_type,
          a.name AS name,
          up.max_hr AS max_hr,
          coalesce(drhr.resting_hr, up.resting_hr, 60) AS resting_hr
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity a ON a.id = asum.activity_id
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(toTimeZone(asum.started_at, {timezone:String})))
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND asum.started_at > now() - INTERVAL {days:Int32} DAY
          AND up.max_hr IS NOT NULL
      )
      SELECT
        any(am.max_hr) AS max_hr,
        any(am.date) AS date,
        any(am.activity_type) AS activity_type,
        any(am.name) AS name,
        round(avg(pwr.scalar), 1) AS avg_power_z2,
        round(avg(hr.scalar), 1) AS avg_hr_z2,
        round(avg(pwr.scalar) / nullIf(avg(hr.scalar), 0), 3) AS efficiency_factor,
        toInt32(count()) AS z2_samples
      FROM activity_meta am
      INNER JOIN analytics.deduped_sensor hr
        ON hr.user_id = am.user_id
       AND hr.recorded_at >= am.started_at
       AND hr.recorded_at <= coalesce(am.ended_at, am.started_at + INTERVAL 12 HOUR)
       AND hr.channel = 'heart_rate'
       AND hr.is_deleted = 0
      INNER JOIN analytics.deduped_sensor pwr
        ON pwr.user_id = hr.user_id
       AND pwr.channel = 'power'
       AND pwr.recorded_at = hr.recorded_at
       AND pwr.is_deleted = 0
      WHERE hr.scalar >= am.resting_hr + (am.max_hr - am.resting_hr) * {b1:Float64}
        AND hr.scalar < am.resting_hr + (am.max_hr - am.resting_hr) * {b2:Float64}
        AND pwr.scalar > 0
      GROUP BY am.id
      HAVING count() >= 300
      ORDER BY any(am.started_at)`,
      {
        userId: this.userId,
        timezone: this.timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
        b1: aerobicEfficiencyZone.minPctHrr,
        b2: aerobicEfficiencyZone.maxPctHrr,
        rhrEndDate: today,
        rhrWindowStart: dateWindowStartString(today, days),
      },
    );

    let emptyResultMaxHr: number | null = null;
    if (rows.length === 0) {
      emptyResultMaxHr = await this.#loadAerobicEfficiencyDiagnostics(days).catch((error) => {
        Sentry.captureException(error);
        return null;
      });
    }

    const firstRow = rows[0];
    const maxHr = firstRow ? Number(firstRow.max_hr) : emptyResultMaxHr;

    return {
      maxHr,
      activities: rows.map((row) => ({
        date: String(row.date),
        activityType: String(row.activity_type),
        name: String(row.name ?? ""),
        avgPowerZ2: Number(row.avg_power_z2),
        avgHrZ2: Number(row.avg_hr_z2),
        efficiencyFactor: Number(row.efficiency_factor),
        z2Samples: Number(row.z2_samples),
      })),
    };
  }

  /** Log a brief diagnostic when aerobic efficiency returns no results. */
  async #loadAerobicEfficiencyDiagnostics(days: number): Promise<number | null> {
    const rows = await this.#sensorStore.query(
      aerobicEfficiencyDiagnosticSchema,
      `WITH endurance_activities AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity a ON a.id = asum.activity_id
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND asum.started_at > now() - INTERVAL {days:Int32} DAY
      )
      SELECT
        (SELECT max_hr FROM postgres_fitness.user_profile_current WHERE id = {userId:UUID}) AS max_hr,
        toInt32(count(DISTINCT id)) AS endurance_activities,
        toInt32(count(DISTINCT if(ds.channel = 'power' AND ds.scalar > 0, ea.id, NULL))) AS activities_with_power,
        toInt32(count(DISTINCT if(ds.channel = 'heart_rate' AND ds.scalar IS NOT NULL, ea.id, NULL))) AS activities_with_hr
      FROM endurance_activities ea
      LEFT JOIN analytics.deduped_sensor ds
        ON ds.user_id = ea.user_id
       AND ds.recorded_at >= ea.started_at
       AND ds.recorded_at <= coalesce(ea.ended_at, ea.started_at + INTERVAL 12 HOUR)
       AND ds.channel IN ('heart_rate', 'power')
       AND ds.is_deleted = 0`,
      {
        userId: this.userId,
        days,
        enduranceTypes: ENDURANCE_TYPES,
      },
    );

    const diag = rows[0];
    if (diag) {
      logger.warn(
        `[aerobicEfficiency] Empty result for user=${this.userId} days=${days}: ` +
          `max_hr=${diag.max_hr}, endurance_activities=${diag.endurance_activities}, ` +
          `with_power=${diag.activities_with_power}, with_hr=${diag.activities_with_hr}`,
      );
      return diag.max_hr;
    }
    return null;
  }

  /**
   * Aerobic Decoupling per activity.
   * Compares power:HR ratio in first half vs second half of each activity.
   * Decoupling < 5% indicates a strong aerobic base.
   */
  async getAerobicDecoupling(days: number): Promise<AerobicDecouplingActivity[]> {
    const rows = await this.#sensorStore.query(
      decouplingRowSchema,
      `WITH activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
          a.activity_type AS activity_type,
          a.name AS name
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity a ON a.id = asum.activity_id
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND asum.started_at > now() - INTERVAL {days:Int32} DAY
      ),
      activity_halves AS (
        SELECT
          am.id AS activity_id,
          pwr.scalar AS power,
          hr.scalar AS heart_rate,
          ntile(2) OVER (PARTITION BY am.id ORDER BY pwr.recorded_at) AS half
        FROM analytics.deduped_sensor pwr
        INNER JOIN activity_meta am
          ON pwr.user_id = am.user_id
         AND pwr.recorded_at >= am.started_at
         AND pwr.recorded_at <= coalesce(am.ended_at, am.started_at + INTERVAL 12 HOUR)
        INNER JOIN analytics.deduped_sensor hr
          ON hr.user_id = pwr.user_id
         AND hr.recorded_at = pwr.recorded_at
         AND hr.channel = 'heart_rate'
         AND hr.is_deleted = 0
        WHERE pwr.channel = 'power'
          AND pwr.scalar > 0
          AND pwr.is_deleted = 0
          AND hr.scalar > 0
      ),
      half_ratios AS (
        SELECT
          activity_id,
          round(avgIf(power, half = 1) / nullIf(avgIf(heart_rate, half = 1), 0), 3) AS first_half_ratio,
          round(avgIf(power, half = 2) / nullIf(avgIf(heart_rate, half = 2), 0), 3) AS second_half_ratio,
          toInt32(count()) AS total_samples
        FROM activity_halves
        GROUP BY activity_id
        HAVING count() >= 600
      )
      SELECT
        am.date AS date,
        am.activity_type AS activity_type,
        am.name AS name,
        hr.first_half_ratio AS first_half_ratio,
        hr.second_half_ratio AS second_half_ratio,
        round((hr.first_half_ratio - hr.second_half_ratio) / nullIf(hr.first_half_ratio, 0) * 100, 2) AS decoupling_pct,
        hr.total_samples AS total_samples
      FROM half_ratios hr
      INNER JOIN activity_meta am ON am.id = hr.activity_id
      WHERE hr.first_half_ratio > 0 AND hr.second_half_ratio > 0
      ORDER BY am.started_at`,
      {
        userId: this.userId,
        timezone: this.timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
      },
    );

    return rows.map((row) => ({
      date: String(row.date),
      activityType: String(row.activity_type),
      name: String(row.name ?? ""),
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
    const polZ1 = polarizationZone2.minPctHrmax;
    const polZ2 = polarizationZone3.minPctHrmax;

    const rows = await this.#sensorStore.query(
      polarizationRowSchema,
      `WITH activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          toDate(toTimeZone(asum.started_at, {timezone:String})) AS activity_date,
          up.max_hr AS max_hr
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity a ON a.id = asum.activity_id
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        WHERE asum.user_id = {userId:UUID}
          AND has({enduranceTypes:Array(String)}, a.activity_type)
          AND asum.started_at > now() - INTERVAL {days:Int32} DAY
          AND up.max_hr IS NOT NULL
      )
      SELECT
        any(am.max_hr) AS max_hr,
        toString(toMonday(am.activity_date)) AS week,
        toInt32(countIf(ds.scalar < am.max_hr * {p1:Float64})) AS z1_seconds,
        toInt32(countIf(ds.scalar >= am.max_hr * {p1:Float64}
                       AND ds.scalar < am.max_hr * {p2:Float64})) AS z2_seconds,
        toInt32(countIf(ds.scalar >= am.max_hr * {p2:Float64})) AS z3_seconds
      FROM analytics.deduped_sensor ds
      INNER JOIN activity_meta am
        ON ds.user_id = am.user_id
       AND ds.recorded_at >= am.started_at
       AND ds.recorded_at <= coalesce(am.ended_at, am.started_at + INTERVAL 12 HOUR)
      WHERE ds.channel = 'heart_rate'
        AND ds.is_deleted = 0
      GROUP BY am.max_hr, toMonday(am.activity_date)
      ORDER BY week`,
      {
        userId: this.userId,
        timezone: this.timezone,
        days,
        enduranceTypes: ENDURANCE_TYPES,
        p1: polZ1,
        p2: polZ2,
      },
    );

    const firstRow = rows[0];
    const maxHr = firstRow ? Number(firstRow.max_hr) : null;

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
