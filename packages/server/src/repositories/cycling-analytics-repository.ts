import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import {
  type CriticalPowerModel,
  DURATION_LABELS,
  fitCriticalPower,
  STANDARD_DURATIONS,
} from "@dofek/training/power-analysis";
import type { Database } from "dofek/db";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { makeTrainingChartAvailability } from "../contracts/training-chart-availability.ts";
import type { ChartRange } from "../lib/chart-range.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { activityMeasurementState } from "../services/activity-data-state.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { ActivityVariabilityModel, VerticalAscentModel } from "./cycling-advanced-models.ts";
import { buildPmcChartFromRows, loadPmcChartParameters } from "./pmc-repository.ts";

const powerComparisonRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  recent_best_power: z.coerce.number().nullable(),
  recent_activity_date: dateStringSchema.nullable(),
  recent_source_activity_id: z.string().nullable().optional(),
  recent_source_activity_name: z.string().nullable().optional(),
  season_best_power: z.coerce.number().nullable(),
  season_activity_date: dateStringSchema.nullable(),
  season_source_activity_id: z.string().nullable().optional(),
  season_source_activity_name: z.string().nullable().optional(),
});

const performanceActivityRowSchema = z.object({
  id: z.string(),
  date: dateStringSchema,
  duration_min: z.coerce.number(),
  avg_hr: z.coerce.number(),
  max_hr: z.coerce.number(),
  global_max_hr: z.coerce.number().nullable(),
  resting_hr: z.coerce.number(),
  avg_power: z.coerce.number().nullable(),
  power_samples: z.coerce.number(),
  hr_samples: z.coerce.number(),
  normalized_power: z.coerce.number().nullable(),
  activity_name: z.string().nullable(),
  latest_weight_kg: z.coerce.number().nullable(),
});

const cyclingActivityRowSchema = z.object({
  id: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  canonical_type: z.string(),
  modality: z.string().nullable(),
  activity_name: z.string().nullable(),
  provider_id: z.string(),
  source_providers: z.array(z.string()),
  distance_meters: z.coerce.number().nullable(),
  date: dateStringSchema,
  normalized_power: z.coerce.number().nullable(),
  average_power: z.coerce.number().nullable(),
  estimated_ftp: z.coerce.number().nullable(),
  elevation_gain_meters: z.coerce.number().nullable(),
  elapsed_seconds: z.coerce.number(),
  max_hr: z.coerce.number().nullable(),
  avg_power_z2: z.coerce.number().nullable(),
  avg_hr_z2: z.coerce.number().nullable(),
  efficiency_factor: z.coerce.number().nullable(),
  z2_samples: z.coerce.number().nullable(),
});

type PowerCurve = {
  points: Array<{
    durationSeconds: number;
    label: string;
    bestPower: number;
    activityDate: string;
    sourceActivityId: string | null;
    sourceActivityName: string | null;
  }>;
  model: CriticalPowerModel | null;
};

function cyclingAvailability(
  chartLabel: string,
  sourceLabel: string,
  dataLabel: string,
  observedCount: number,
) {
  return makeTrainingChartAvailability({
    sourceLabel,
    observedCount,
    minimumCount: 1,
    messages: {
      available: `${chartLabel} is available from ${sourceLabel}.`,
      insufficientData: `No ${chartLabel} is available from ${sourceLabel}. Record at least 1 cycling activity with ${dataLabel} to show this chart.`,
    },
  });
}

type EstimateConfidence = "high" | "moderate" | "limited" | "not_available";

type SourceWorkout = {
  id: string;
  name: string | null;
  date: string;
};

type EstimateEvidence = {
  method: string;
  confidence: EstimateConfidence;
  confidenceLabel: string;
  confidenceDetail: string;
  sourceWorkouts: SourceWorkout[];
  pacingGuidance: string;
};

function sourceWorkoutsForPoints(
  points: PowerCurve["points"],
  predicate: (point: PowerCurve["points"][number]) => boolean = () => true,
): SourceWorkout[] {
  const sourceWorkouts: SourceWorkout[] = [];
  const seenActivityIds = new Set<string>();

  for (const point of points) {
    if (
      !predicate(point) ||
      point.sourceActivityId == null ||
      seenActivityIds.has(point.sourceActivityId)
    ) {
      continue;
    }
    seenActivityIds.add(point.sourceActivityId);
    sourceWorkouts.push({
      id: point.sourceActivityId,
      name: point.sourceActivityName,
      date: point.activityDate,
    });
  }

  return sourceWorkouts;
}

function buildThresholdEvidence(curve: PowerCurve): EstimateEvidence {
  const fittingPoints = curve.points.filter(
    (point) => point.durationSeconds >= 120 && point.durationSeconds <= 600 && point.bestPower > 0,
  );
  const sourceWorkouts = sourceWorkoutsForPoints(curve.points, (point) =>
    fittingPoints.some((fittingPoint) => fittingPoint.durationSeconds === point.durationSeconds),
  );
  const method = "Critical Power model fitted to 120–600 second best-power efforts";
  const pacingGuidance =
    "Use this as a training estimate, not a tested threshold; do not set pacing from it when the fit is unavailable or limited.";

  if (curve.model == null) {
    return {
      method,
      confidence: "not_available",
      confidenceLabel: "Not available",
      confidenceDetail: "At least three usable power durations are required for this fit.",
      sourceWorkouts,
      pacingGuidance,
    };
  }

  const fitPercentage = Math.round(Math.max(0, Math.min(1, curve.model.r2)) * 100);
  const confidence: EstimateConfidence =
    fittingPoints.length >= 4 && curve.model.r2 >= 0.9
      ? "high"
      : fittingPoints.length >= 3 && curve.model.r2 >= 0.75
        ? "moderate"
        : "limited";
  const confidenceLabel =
    confidence === "high"
      ? "High fit quality"
      : confidence === "moderate"
        ? "Moderate fit quality"
        : "Limited fit quality";

  return {
    method,
    confidence,
    confidenceLabel,
    confidenceDetail: `${confidenceLabel} across ${fittingPoints.length} observed power durations (${fitPercentage}% fit to the observed efforts).`,
    sourceWorkouts,
    pacingGuidance,
  };
}

function buildVo2MaxEvidence(curve: PowerCurve, weightKg: number | null): EstimateEvidence {
  const maximalAerobicPowerPoint = curve.points.find((point) => point.durationSeconds === 300);
  const sourceWorkouts = maximalAerobicPowerPoint
    ? sourceWorkoutsForPoints(curve.points, (point) => point.durationSeconds === 300)
    : [];
  const hasEstimate =
    maximalAerobicPowerPoint != null &&
    weightKg != null &&
    weightKg > 0 &&
    sourceWorkouts.length > 0;

  return {
    method: "Indirect estimate from 5-minute maximal aerobic power and latest body weight",
    confidence: hasEstimate ? "limited" : "not_available",
    confidenceLabel: hasEstimate ? "Indirect estimate" : "Not available",
    confidenceDetail: hasEstimate
      ? "A field estimate, not a laboratory measurement."
      : "A 5-minute power effort and a positive body-weight measurement are required.",
    sourceWorkouts,
    pacingGuidance:
      "Do not use this estimate to set workout pacing; use a validated test when precision matters.",
  };
}

function sourceWorkoutsForTrend(
  rows: z.infer<typeof performanceActivityRowSchema>[],
): SourceWorkout[] {
  return rows.slice(-5).map((row) => ({
    id: row.id,
    name: row.activity_name,
    date: row.date,
  }));
}

function buildPowerCurve(
  rows: z.infer<typeof powerComparisonRowSchema>[],
  period: "recent" | "season",
): PowerCurve {
  const points = STANDARD_DURATIONS.flatMap((durationSeconds) => {
    const row = rows.find((candidate) => candidate.duration_seconds === durationSeconds);
    const bestPower = period === "recent" ? row?.recent_best_power : row?.season_best_power;
    const activityDate =
      period === "recent" ? row?.recent_activity_date : row?.season_activity_date;
    if (bestPower == null || activityDate == null) return [];
    return [
      {
        durationSeconds,
        label: DURATION_LABELS[durationSeconds] ?? `${durationSeconds}s`,
        bestPower,
        activityDate,
        sourceActivityId:
          (period === "recent" ? row?.recent_source_activity_id : row?.season_source_activity_id) ??
          null,
        sourceActivityName:
          (period === "recent"
            ? row?.recent_source_activity_name
            : row?.season_source_activity_name) ?? null,
      },
    ];
  });
  return { points, model: fitCriticalPower(points) };
}

function powerSummaryPeriod(curve: PowerCurve, weightKg: number | null) {
  const maximalAerobicPower =
    curve.points.find((point) => point.durationSeconds === 300)?.bestPower ?? null;
  const vo2Max =
    maximalAerobicPower != null && weightKg != null && weightKg > 0
      ? Math.round(((maximalAerobicPower / weightKg) * 10.8 + 7) * 10) / 10
      : null;
  const timeToExhaustionSeconds =
    curve.model != null && maximalAerobicPower != null && maximalAerobicPower > curve.model.cp
      ? curve.model.wPrime / (maximalAerobicPower - curve.model.cp)
      : null;
  return {
    efforts: curve.points
      .filter((point) => [5, 60, 300, 1200].includes(point.durationSeconds))
      .map((point) => ({
        durationSeconds: point.durationSeconds,
        watts: point.bestPower,
        wattsPerKg:
          weightKg != null && weightKg > 0
            ? Math.round((point.bestPower / weightKg) * 100) / 100
            : null,
      })),
    maximalAerobicPower,
    vo2Max,
    timeToExhaustionSeconds,
  };
}

export interface CyclingActivitiesPagination {
  activityLimit: number;
  activityOffset: number;
  variabilityLimit: number;
  variabilityOffset: number;
}

export class CyclingAnalyticsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;
  readonly #accessWindow: AccessWindow | undefined;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
    accessWindow?: AccessWindow,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
    this.#accessWindow = accessWindow;
  }

  async getPerformance(range: ChartRange) {
    const pmcParameters = await loadPmcChartParameters(this.#db, this.#userId, range);
    const comparisonRows = await this.#sensorStore.query(
      powerComparisonRowSchema,
      `SELECT
        power_curve.duration_seconds AS duration_seconds,
        argMaxIf(
          power_curve.best_power,
          power_curve.best_power,
          ${range.isAll() ? "true" : "power_curve.started_at > now() - INTERVAL {days:Int32} DAY"}
        ) AS recent_best_power,
        argMaxIf(
          toDate(toTimeZone(power_curve.started_at, {timezone:String})),
          power_curve.best_power,
          ${range.isAll() ? "true" : "power_curve.started_at > now() - INTERVAL {days:Int32} DAY"}
        ) AS recent_activity_date,
        argMaxIf(
          toString(power_curve.activity_id),
          power_curve.best_power,
          ${range.isAll() ? "true" : "power_curve.started_at > now() - INTERVAL {days:Int32} DAY"}
        ) AS recent_source_activity_id,
        argMaxIf(
          activity.activity_name,
          power_curve.best_power,
          ${range.isAll() ? "true" : "power_curve.started_at > now() - INTERVAL {days:Int32} DAY"}
        ) AS recent_source_activity_name,
        argMaxIf(power_curve.best_power, power_curve.best_power, power_curve.started_at > now() - INTERVAL 365 DAY) AS season_best_power,
        argMaxIf(toDate(toTimeZone(power_curve.started_at, {timezone:String})), power_curve.best_power, power_curve.started_at > now() - INTERVAL 365 DAY) AS season_activity_date,
        argMaxIf(toString(power_curve.activity_id), power_curve.best_power, power_curve.started_at > now() - INTERVAL 365 DAY) AS season_source_activity_id,
        argMaxIf(activity.activity_name, power_curve.best_power, power_curve.started_at > now() - INTERVAL 365 DAY) AS season_source_activity_name
      FROM analytics.activity_power_curve AS power_curve FINAL
      INNER JOIN analytics.cycling_activity AS activity FINAL
        ON activity.user_id = power_curve.user_id
       AND activity.activity_id = power_curve.activity_id
       AND activity.is_deleted = 0
      WHERE power_curve.user_id = {userId:UUID}
        AND power_curve.is_deleted = 0
        ${this.#accessWindowPredicate("power_curve.started_at")}
      GROUP BY power_curve.duration_seconds
      ORDER BY power_curve.duration_seconds`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...range.clickHouseParams(),
        ...this.#accessWindowParams(),
      },
      { priority: "dashboard" },
    );

    const historyRange = pmcParameters.queryRange;
    const activityRows = await this.#sensorStore.query(
      performanceActivityRowSchema,
      `WITH latest_weight AS (
        SELECT nullIf(argMax(weight_kg, recorded_at), 0) AS weight_kg
        FROM analytics.daily_body_measurement FINAL
        WHERE user_id = {userId:UUID}
          AND is_deleted = 0
          ${this.#accessWindowPredicate("recorded_at")}
      ),
      user_baseline AS (
        SELECT
          coalesce(
            nullIf(max_hr, 0),
            (
              SELECT max(max_heart_rate)
              FROM analytics.cycling_activity FINAL
              WHERE user_id = {userId:UUID}
                AND is_deleted = 0
                ${this.#accessWindowPredicate("started_at")}
            )
          ) AS global_max_hr,
          coalesce(nullIf(resting_hr, 0), 60) AS resting_hr
        FROM postgres_fitness.user_profile_current
        WHERE id = {userId:UUID}
      )
      SELECT
        toString(activity.1) AS id,
        toString(toDate(toTimeZone(activity.2, {timezone:String}))) AS date,
        activity.3 AS duration_min,
        activity.4 AS avg_hr,
        activity.5 AS max_hr,
        user_baseline.global_max_hr AS global_max_hr,
        user_baseline.resting_hr AS resting_hr,
        activity.6 AS avg_power,
        activity.7 AS power_samples,
        activity.8 AS hr_samples,
        activity.9 AS normalized_power,
        activity.10 AS activity_name,
        latest_weight.weight_kg AS latest_weight_kg
      FROM analytics.daily_cycling AS daily FINAL
      CROSS JOIN latest_weight
      CROSS JOIN user_baseline
      ARRAY JOIN daily.activities AS activity
      WHERE daily.user_id = {userId:UUID}
        AND daily.is_deleted = 0
        ${historyRange.clickHouseDateAfterToday("daily.date")}
        ${this.#accessWindowPredicate("activity.2")}
      ORDER BY activity.2`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...historyRange.clickHouseParams(),
        ...this.#accessWindowParams(),
      },
      { priority: "dashboard" },
    );

    const recent = buildPowerCurve(comparisonRows, "recent");
    const season = buildPowerCurve(comparisonRows, "season");
    const weightKg = activityRows[0]?.latest_weight_kg ?? null;
    const normalizedPowerRows = activityRows.flatMap((row) =>
      row.normalized_power == null ? [] : [{ activity_id: row.id, np: row.normalized_power }],
    );
    const pmc = await buildPmcChartFromRows({
      db: this.#db,
      userId: this.#userId,
      range,
      activityRows,
      normalizedPowerRows,
      parameters: pmcParameters,
    });
    const trendWindowStart = range.windowStartString(new Date().toISOString().slice(0, 10));
    const trendRows = activityRows
      .filter((row) => row.normalized_power != null)
      .filter((row) => trendWindowStart === undefined || row.date > trendWindowStart);
    const trend = trendRows.map((row) => ({
      date: row.date,
      eftp: Math.round((row.normalized_power ?? 0) * 0.95),
      activityName: row.activity_name,
    }));
    const currentEftp =
      recent.model?.cp ?? (trend.length > 0 ? Math.max(...trend.map((row) => row.eftp)) : null);
    const recentThresholdEvidence = buildThresholdEvidence(recent);
    const seasonThresholdEvidence = buildThresholdEvidence(season);

    return {
      powerCurve: { recent, season },
      powerSummary: {
        weightKg,
        recent: powerSummaryPeriod(recent, weightKg),
        season: powerSummaryPeriod(season, weightKg),
      },
      pmc,
      eftpTrend: { trend, currentEftp, model: recent.model },
      availability: {
        powerCurve: cyclingAvailability(
          "cycling power-curve data",
          "Cycling power-curve read model",
          "power data",
          recent.points.length,
        ),
        pmc: cyclingAvailability(
          "training-load data",
          "Cycling training-load model",
          "training-load data",
          pmc.data.length,
        ),
        eftpTrend: cyclingAvailability(
          "threshold power data",
          "Cycling activity power summaries",
          "power data",
          trend.length,
        ),
      },
      estimateEvidence: {
        recent: {
          threshold: recentThresholdEvidence,
          vo2Max: buildVo2MaxEvidence(recent, weightKg),
        },
        season: {
          threshold: seasonThresholdEvidence,
          vo2Max: buildVo2MaxEvidence(season, weightKg),
        },
        eftp: {
          method: recent.model
            ? "Critical Power model for the current value; trend points use normalized power × 0.95"
            : "Normalized power × 0.95 for each cycling workout",
          confidence:
            currentEftp == null
              ? "not_available"
              : recent.model
                ? recentThresholdEvidence.confidence
                : "limited",
          confidenceLabel:
            currentEftp == null
              ? "Not available"
              : recent.model
                ? recentThresholdEvidence.confidenceLabel
                : "Training estimate",
          confidenceDetail:
            currentEftp == null
              ? "A cycling workout with normalized power is required."
              : recent.model
                ? "The current value uses the threshold model; the trend shows per-workout estimates."
                : `Based on ${trendRows.length} source cycling workout${trendRows.length === 1 ? "" : "s"}.`,
          sourceWorkouts: sourceWorkoutsForTrend(trendRows),
          pacingGuidance:
            "Do not use this estimate to set pacing when the source ride is not representative of the effort you want to pace.",
        },
      },
    };
  }

  async getActivities(range: ChartRange, pagination: CyclingActivitiesPagination) {
    const rows = await this.#sensorStore.query(
      cyclingActivityRowSchema,
      `SELECT
        toString(activity_id) AS id,
        started_at AS started_at,
        ended_at AS ended_at,
        canonical_type AS canonical_type,
        modality AS modality,
        activity_name AS activity_name,
        provider_id AS provider_id,
        source_providers AS source_providers,
        distance_meters AS distance_meters,
        toString(toDate(toTimeZone(started_at, {timezone:String}))) AS date,
        normalized_power AS normalized_power,
        average_power AS average_power,
        round(max(best_twenty_minute_power) OVER () * 0.95, 1) AS estimated_ftp,
        elevation_gain_meters AS elevation_gain_meters,
        elapsed_seconds AS elapsed_seconds,
        efficiency_max_heart_rate AS max_hr,
        average_power_zone_two AS avg_power_z2,
        average_heart_rate_zone_two AS avg_hr_z2,
        efficiency_factor AS efficiency_factor,
        zone_two_samples AS z2_samples
      FROM analytics.cycling_activity FINAL
      WHERE user_id = {userId:UUID}
        AND is_deleted = 0
        ${range.clickHouseTimestampAfter("started_at")}
        ${this.#accessWindowPredicate("started_at")}
      ORDER BY started_at DESC`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...range.clickHouseParams(),
        ...this.#accessWindowParams(),
      },
      { priority: "dashboard" },
    );

    const powerCandidates = rows.filter(
      (
        row,
      ): row is typeof row & {
        normalized_power: number;
        average_power: number;
      } => row.normalized_power != null && row.average_power != null && row.average_power > 0,
    );
    const variabilityCandidates = powerCandidates.filter(
      (row): row is typeof row & { estimated_ftp: number } =>
        row.estimated_ftp != null && row.estimated_ftp > 0,
    );
    const variabilityRows = variabilityCandidates
      .slice(
        pagination.variabilityOffset,
        pagination.variabilityOffset + pagination.variabilityLimit,
      )
      .map((row) =>
        new ActivityVariabilityModel(
          {
            activityId: row.id,
            date: row.date,
            activityName: row.activity_name ?? row.canonical_type,
            normalizedPower: row.normalized_power,
            averagePower: row.average_power,
          },
          row.estimated_ftp,
        ).toDetail(),
      );
    const verticalAscent = rows
      .filter(
        (row) =>
          !isIndoorCyclingModality(row.modality) &&
          row.elevation_gain_meters != null &&
          row.elapsed_seconds > 0,
      )
      .map((row) =>
        new VerticalAscentModel({
          date: row.date,
          activityName: row.activity_name ?? row.canonical_type,
          activityType: row.canonical_type,
          modality: row.modality ?? null,
          elevationGainMeters: row.elevation_gain_meters ?? 0,
          elapsedSeconds: row.elapsed_seconds,
        }).toDetail(),
      );
    const efficiencyActivities = rows
      .filter(
        (row) =>
          row.avg_power_z2 != null &&
          row.avg_power_z2 > 0 &&
          row.avg_hr_z2 != null &&
          row.avg_hr_z2 > 0 &&
          row.efficiency_factor != null &&
          row.efficiency_factor > 0 &&
          row.z2_samples != null &&
          row.z2_samples >= 300,
      )
      .map((row) => ({
        date: row.date,
        activityType: row.canonical_type,
        name: row.activity_name ?? row.canonical_type,
        avgPowerZ2: row.avg_power_z2 ?? 0,
        avgHrZ2: row.avg_hr_z2 ?? 0,
        efficiencyFactor: row.efficiency_factor ?? 0,
        z2Samples: row.z2_samples ?? 0,
      }))
      .reverse();
    const activityItems = rows
      .slice(pagination.activityOffset, pagination.activityOffset + pagination.activityLimit)
      .map((row) => ({
        id: row.id,
        started_at: row.started_at,
        ended_at: row.ended_at,
        canonical_type: row.canonical_type,
        name: row.activity_name,
        provider_id: row.provider_id,
        source_providers: row.source_providers,
        distance_meters: row.distance_meters,
        distance_state: activityMeasurementState("Distance", row.distance_meters),
        elevation_gain_m: row.elevation_gain_meters,
        elevation_state: activityMeasurementState("Elevation gain", row.elevation_gain_meters),
      }));

    return {
      activities: { items: activityItems, totalCount: rows.length },
      variability: {
        rows: variabilityRows,
        totalCount: variabilityCandidates.length,
        emptyReason:
          rows.length === 0
            ? ("no_cycling_activities" as const)
            : powerCandidates.length === 0
              ? ("no_normalized_power" as const)
              : variabilityCandidates.length === 0
                ? ("no_ftp_estimate" as const)
                : null,
      },
      verticalAscent,
      aerobicEfficiency: {
        maxHr: rows.find((row) => row.max_hr != null && row.max_hr > 0)?.max_hr ?? null,
        activities: efficiencyActivities,
      },
      availability: {
        verticalAscent: cyclingAvailability(
          "vertical ascent data",
          "Cycling activity altitude sensor summaries",
          "altitude data",
          verticalAscent.length,
        ),
        aerobicEfficiency: cyclingAvailability(
          "aerobic efficiency data",
          "Cycling Zone 2 power and heart-rate summaries",
          "Zone 2 power and heart-rate data",
          efficiencyActivities.length,
        ),
      },
    };
  }

  #accessWindowPredicate(column: string): string {
    return this.#accessWindow?.kind === "limited"
      ? `AND ${column} >= parseDateTime64BestEffort({accessStartDate:String}, 6, 'UTC')
         AND ${column} < parseDateTime64BestEffort({accessEndDateExclusive:String}, 6, 'UTC')`
      : "";
  }

  #accessWindowParams(): Record<string, string> {
    return this.#accessWindow?.kind === "limited"
      ? {
          accessStartDate: this.#accessWindow.startDate,
          accessEndDateExclusive: this.#accessWindow.endDateExclusive,
        }
      : {};
  }
}
