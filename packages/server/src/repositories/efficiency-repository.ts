import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import {
  buildTreffPolarizationWeek,
  type TreffPolarizationWeek,
} from "@dofek/training/training-distribution";
import { computePolarizationIndex, HEART_RATE_ZONES } from "@dofek/zones/zones";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import type { ChartRange } from "../lib/chart-range.ts";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { restingHeartRateClickHouseCte } from "./resting-heart-rate-query.ts";

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];

function requireHeartRateZone(zoneNumber: number) {
  const zone = HEART_RATE_ZONES.find((zoneDefinition) => zoneDefinition.zone === zoneNumber);
  if (!zone) {
    throw new Error(`Heart-rate zone ${zoneNumber} definition is required`);
  }
  return zone;
}

const aerobicEfficiencyZone = requireHeartRateZone(2);

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

export type PolarizationWeek = TreffPolarizationWeek;

export interface PolarizationTrendResult {
  model: "treff-three-zone";
  activityScope: "cycling";
  threshold: 2;
  maxHr: number | null;
  weeks: PolarizationWeek[];
  explanation: string;
  method: {
    formula: string;
    zoneBasis: string;
    calculationChoice: string;
    interpretation: string;
    source: {
      title: string;
      url: string;
    };
  };
}

const POLARIZATION_RESULT_METADATA = {
  model: "treff-three-zone" as const,
  activityScope: "cycling" as const,
  threshold: 2 as const,
  explanation:
    "The Treff three-zone polarization index is a descriptive summary of recorded cycling training.",
};

function createPolarizationMethod(): PolarizationTrendResult["method"] {
  return {
    formula:
      "Polarization index = log10((easy-zone fraction / threshold-zone fraction) × high-zone fraction × 100).",
    zoneBasis:
      "Easy zone (Zone 1) is below 80%, threshold zone (Zone 2) is 80–<90%, and high zone (Zone 3) is at least 90% of maximum heart rate.",
    calculationChoice:
      "Dofek requires recorded time in all three zones and does not calculate the polarization index when high-zone time exceeds easy-zone time.",
    interpretation:
      "The >2.00 comparison is Treff's descriptive training-distribution heuristic, not a physiological or medical assessment.",
    source: {
      title: "Treff et al. (2019), The Polarization-Index",
      url: "https://doi.org/10.3389/fphys.2019.00707",
    },
  };
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
});

const aerobicEfficiencySampleDiagnosticSchema = z.object({
  activities_with_power: z.coerce.number(),
  activities_with_hr: z.coerce.number(),
});

type AerobicEfficiencyDiagnostic = z.infer<typeof aerobicEfficiencyDiagnosticSchema>;

function restingHeartRateRangeParams(
  endDate: string,
  range: ChartRange,
): { rhrEndDate: string; rhrWindowStart?: string } {
  const rhrWindowStart = range.windowStartString(endDate);
  return rhrWindowStart === undefined
    ? { rhrEndDate: endDate }
    : { rhrEndDate: endDate, rhrWindowStart };
}

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
   * Reads from the pre-computed activity_aerobic_efficiency read model when available.
   */
  async getAerobicEfficiency(range: ChartRange): Promise<AerobicEfficiencyResult> {
    const today = new Date().toISOString().slice(0, 10);
    const lowerBoundPredicate = range.clickHouseTimestampAfter("started_at");
    const activitySummaryLowerBoundPredicate = range.clickHouseTimestampAfter("asum.started_at");
    const powerSampleLowerBoundPredicate = range.clickHouseTimestampAfter("power.recorded_at");
    const rangeParams = range.clickHouseParams();

    // Try pre-computed read model first (avoids expensive deduped_sensor scan)
    const readModelRows = await this.#sensorStore.query(
      efficiencyRowSchema,
      `SELECT
        max_hr AS max_hr,
        toString(toDate(toTimeZone(started_at, {timezone:String}))) AS date,
        activity_type AS activity_type,
        name AS name,
        avg_power_z2 AS avg_power_z2,
        avg_hr_z2 AS avg_hr_z2,
        efficiency_factor AS efficiency_factor,
        z2_samples AS z2_samples
      FROM analytics.activity_aerobic_efficiency FINAL
      WHERE user_id = {userId:UUID}
        AND has({activityTypes:Array(String)}, activity_type)
        ${lowerBoundPredicate}
        AND is_deleted = 0
      ORDER BY started_at`,
      {
        userId: this.userId,
        timezone: this.timezone,
        ...rangeParams,
        activityTypes: CYCLING_TYPES,
      },
    );

    if (readModelRows.length > 0) {
      return {
        maxHr: Number(readModelRows[0]?.max_hr),
        activities: readModelRows.map((row) => ({
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

    // Fall back to live deduped_sensor computation
    const activityDiagnostic = await this.#loadAerobicEfficiencyActivityDiagnostics(range);

    if (activityDiagnostic?.endurance_activities === 0) {
      this.#logAerobicEfficiencyEmptyDiagnostic(activityDiagnostic, range, {
        activities_with_power: 0,
        activities_with_hr: 0,
      });
      return {
        maxHr: activityDiagnostic.max_hr,
        activities: [],
      };
    }

    const rows = await this.#sensorStore.query(
      efficiencyRowSchema,
      `WITH ${restingHeartRateClickHouseCte({ includeWindowStart: !range.isAll() })},
      activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
          asum.activity_type AS activity_type,
          asum.name AS name,
          up.max_hr AS max_hr,
          coalesce(drhr.resting_hr, up.resting_hr, 60) AS resting_hr
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity va
          ON va.id = asum.activity_id
         AND va.user_id = asum.user_id
        INNER JOIN postgres_fitness.user_profile_current up ON up.id = asum.user_id
        LEFT JOIN resting_heart_rate drhr
          ON drhr.date = toString(toDate(toTimeZone(asum.started_at, {timezone:String})))
        WHERE asum.user_id = {userId:UUID}
          AND has({activityTypes:Array(String)}, asum.activity_type)
          ${activitySummaryLowerBoundPredicate}
          AND up.max_hr IS NOT NULL
      )
      SELECT
        any(hr.max_hr) AS max_hr,
        any(hr.date) AS date,
        any(hr.activity_type) AS activity_type,
        any(hr.name) AS name,
        round(avg(pwr.scalar), 1) AS avg_power_z2,
        round(avg(hr.heart_rate), 1) AS avg_hr_z2,
        round(avg(pwr.scalar) / nullIf(avg(hr.heart_rate), 0), 3) AS efficiency_factor,
        toInt32(count()) AS z2_samples
      FROM (
        SELECT
          am.id AS id,
          am.user_id AS user_id,
          am.started_at AS started_at,
          am.ended_at AS ended_at,
          am.date AS date,
          am.activity_type AS activity_type,
          am.name AS name,
          am.max_hr AS max_hr,
          hr.recorded_at AS recorded_at,
          hr.scalar AS heart_rate
        FROM activity_meta am
        INNER JOIN analytics.deduped_sensor hr
          ON hr.user_id = am.user_id
         AND hr.recorded_at >= am.started_at
         AND hr.recorded_at <= coalesce(am.ended_at, am.started_at + INTERVAL 12 HOUR)
         AND hr.channel = 'heart_rate'
         AND hr.is_deleted = 0
        WHERE hr.scalar >= am.resting_hr + (am.max_hr - am.resting_hr) * {b1:Float64}
          AND hr.scalar < am.resting_hr + (am.max_hr - am.resting_hr) * {b2:Float64}
        ORDER BY
          am.user_id,
          am.id,
          hr.recorded_at
      ) hr
      ASOF JOIN (
        SELECT
          am.id AS id,
          am.user_id AS user_id,
          power.recorded_at AS recorded_at,
          power.scalar AS scalar
        FROM activity_meta am
        INNER JOIN analytics.deduped_sensor power
          ON power.user_id = am.user_id
         AND power.recorded_at >= am.started_at
         AND power.recorded_at <= coalesce(am.ended_at, am.started_at + INTERVAL 12 HOUR)
         AND power.channel = 'power'
         AND power.scalar > 0
         AND power.is_deleted = 0
        WHERE 1 = 1
          ${powerSampleLowerBoundPredicate}
        ORDER BY
          user_id,
          id,
          recorded_at
      ) pwr
        ON hr.user_id = pwr.user_id
       AND hr.id = pwr.id
       AND hr.recorded_at >= pwr.recorded_at
      GROUP BY hr.id
      HAVING count() >= 300
      ORDER BY any(hr.started_at)`,
      {
        userId: this.userId,
        timezone: this.timezone,
        ...rangeParams,
        activityTypes: CYCLING_TYPES,
        b1: aerobicEfficiencyZone.minPctHrr,
        b2: aerobicEfficiencyZone.maxPctHrr,
        ...restingHeartRateRangeParams(today, range),
      },
    );

    let emptyResultMaxHr: number | null = null;
    if (rows.length === 0) {
      emptyResultMaxHr = await this.#loadAerobicEfficiencyDiagnostics(
        range,
        activityDiagnostic,
      ).catch((error) => {
        captureException(error);
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
  async #loadAerobicEfficiencyActivityDiagnostics(
    range: ChartRange,
  ): Promise<AerobicEfficiencyDiagnostic | null> {
    const rows = await this.query(
      aerobicEfficiencyDiagnosticSchema,
      sql`WITH endurance_activities AS (
            SELECT id
            FROM fitness.v_activity
            WHERE user_id = ${this.userId}::uuid
              AND activity_type IN (${sql.join(
                CYCLING_TYPES.map((activityType) => sql`${activityType}`),
                sql`, `,
              )})
              ${range.postgresTimestampAfterCurrentTimestamp(sql`started_at`)}
          )
          SELECT
            (SELECT max_hr FROM fitness.user_profile WHERE id = ${this.userId}::uuid) AS max_hr,
            count(*)::int AS endurance_activities
          FROM endurance_activities`,
    );

    return rows[0] ?? null;
  }

  /** Log a brief diagnostic when aerobic efficiency returns no results. */
  async #loadAerobicEfficiencyDiagnostics(
    range: ChartRange,
    knownActivityDiagnostic: AerobicEfficiencyDiagnostic | null,
  ): Promise<number | null> {
    const activityDiagnostic =
      knownActivityDiagnostic ?? (await this.#loadAerobicEfficiencyActivityDiagnostics(range));
    if (!activityDiagnostic) {
      return null;
    }

    if (activityDiagnostic.endurance_activities === 0) {
      this.#logAerobicEfficiencyEmptyDiagnostic(activityDiagnostic, range, {
        activities_with_power: 0,
        activities_with_hr: 0,
      });
      return activityDiagnostic.max_hr;
    }

    const sampleRows = await this.#sensorStore.query(
      aerobicEfficiencySampleDiagnosticSchema,
      `WITH endurance_activities AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity va
          ON va.id = asum.activity_id
         AND va.user_id = asum.user_id
        WHERE asum.user_id = {userId:UUID}
          AND has({activityTypes:Array(String)}, asum.activity_type)
          ${range.clickHouseTimestampAfter("asum.started_at")}
      ),
      sensor_samples_by_activity AS (
        SELECT
          ea.id AS activity_id,
          countIf(ds.channel = 'power' AND ds.scalar > 0) AS power_samples,
          countIf(ds.channel = 'heart_rate' AND ds.scalar IS NOT NULL) AS heart_rate_samples
        FROM endurance_activities ea
        INNER JOIN analytics.deduped_sensor ds
          ON ds.user_id = ea.user_id
        WHERE ds.recorded_at >= ea.started_at
          AND ds.recorded_at <= coalesce(ea.ended_at, ea.started_at + INTERVAL 12 HOUR)
          AND ds.channel IN ('heart_rate', 'power')
          AND ds.is_deleted = 0
        GROUP BY ea.id
      )
      SELECT
        toInt32(countIf(sensor_samples.power_samples > 0)) AS activities_with_power,
        toInt32(countIf(sensor_samples.heart_rate_samples > 0)) AS activities_with_hr
      FROM endurance_activities ea
      LEFT JOIN sensor_samples_by_activity sensor_samples
        ON sensor_samples.activity_id = ea.id`,
      {
        userId: this.userId,
        ...range.clickHouseParams(),
        activityTypes: CYCLING_TYPES,
      },
    );

    const sampleDiagnostic = sampleRows[0] ?? { activities_with_power: 0, activities_with_hr: 0 };
    this.#logAerobicEfficiencyEmptyDiagnostic(activityDiagnostic, range, sampleDiagnostic);
    return activityDiagnostic.max_hr;
  }

  #logAerobicEfficiencyEmptyDiagnostic(
    activityDiagnostic: AerobicEfficiencyDiagnostic,
    range: ChartRange,
    sampleDiagnostic: z.infer<typeof aerobicEfficiencySampleDiagnosticSchema>,
  ): void {
    logger.warn(
      `[aerobicEfficiency] Empty result for user=${this.userId} days=${range.days}: ` +
        `max_hr=${activityDiagnostic.max_hr}, ` +
        `endurance_activities=${activityDiagnostic.endurance_activities}, ` +
        `with_power=${sampleDiagnostic.activities_with_power}, ` +
        `with_hr=${sampleDiagnostic.activities_with_hr}`,
    );
  }

  /**
   * Aerobic Decoupling per activity.
   * Compares power:HR ratio in first half vs second half of each activity.
   * Decoupling < 5% indicates a strong aerobic base.
   */
  async getAerobicDecoupling(range: ChartRange): Promise<AerobicDecouplingActivity[]> {
    const rows = await this.#sensorStore.query(
      decouplingRowSchema,
      `WITH activity_meta AS (
        SELECT
          asum.activity_id AS id,
          asum.user_id AS user_id,
          asum.started_at AS started_at,
          asum.ended_at AS ended_at,
          toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
          asum.activity_type AS activity_type,
          asum.name AS name
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity va
          ON va.id = asum.activity_id
         AND va.user_id = asum.user_id
        WHERE asum.user_id = {userId:UUID}
          AND has({activityTypes:Array(String)}, asum.activity_type)
          ${range.clickHouseTimestampAfter("asum.started_at")}
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
        ...range.clickHouseParams(),
        activityTypes: CYCLING_TYPES,
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
   * PI = log10((f1 / f2) * f3 * 100) where f = fraction of total training time.
   * PI > 2.0 matches Treff's descriptive polarized-distribution heuristic.
   * Reads from the pre-computed activity_polarization_zones read model.
   */
  async getPolarizationTrend(range: ChartRange): Promise<PolarizationTrendResult> {
    const lowerBoundPredicate = range.clickHouseTimestampAfter("started_at");
    const rangeParams = range.clickHouseParams();

    const rows = await this.#sensorStore.query(
      polarizationRowSchema,
      `SELECT
        any(max_hr) AS max_hr,
        toString(toMonday(toTimeZone(started_at, {timezone:String}))) AS week,
        toInt32(sum(z1_seconds)) AS z1_seconds,
        toInt32(sum(z2_seconds)) AS z2_seconds,
        toInt32(sum(z3_seconds)) AS z3_seconds
      FROM analytics.activity_polarization_zones FINAL
      WHERE user_id = {userId:UUID}
        AND has({activityTypes:Array(String)}, activity_type)
        ${lowerBoundPredicate}
        AND is_deleted = 0
      GROUP BY toMonday(toTimeZone(started_at, {timezone:String}))
      ORDER BY week`,
      {
        userId: this.userId,
        timezone: this.timezone,
        ...rangeParams,
        activityTypes: CYCLING_TYPES,
      },
    );

    const firstRow = rows[0];
    const maxHr = firstRow ? Number(firstRow.max_hr) : null;

    const weeks: PolarizationWeek[] = rows.map((row) => {
      const z1 = Number(row.z1_seconds);
      const z2 = Number(row.z2_seconds);
      const z3 = Number(row.z3_seconds);

      return buildTreffPolarizationWeek({
        week: String(row.week),
        z1Seconds: z1,
        z2Seconds: z2,
        z3Seconds: z3,
        polarizationIndex: computePolarizationIndex(z1, z2, z3),
      });
    });

    return {
      ...POLARIZATION_RESULT_METADATA,
      method: createPolarizationMethod(),
      maxHr,
      weeks,
    };
  }
}
