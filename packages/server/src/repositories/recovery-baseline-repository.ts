import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import {
  type BaselineRelativeMetric,
  baselineRelativeMetricSchema,
  buildBaselineRelativeMetric,
} from "../contracts/baseline-relative-metrics.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorQueryOptions, ActivitySensorStore } from "./activity-repository.ts";

const recoveryBaselineRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  respiratory_rate: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
  hrv_mean_30d: z.coerce.number().nullable(),
  hrv_sd_30d: z.coerce.number().nullable(),
  hrv_z_score: z.coerce.number().nullable(),
  hrv_baseline_sample_count: z.coerce.number().int(),
  hrv_baseline_coverage: z.coerce.number(),
  hrv_mean_7d: z.coerce.number().nullable(),
  hrv_mean_previous_28d: z.coerce.number().nullable(),
  rhr_mean_30d: z.coerce.number().nullable(),
  rhr_sd_30d: z.coerce.number().nullable(),
  resting_hr_z_score: z.coerce.number().nullable(),
  rhr_baseline_sample_count: z.coerce.number().int(),
  rhr_baseline_coverage: z.coerce.number(),
  rhr_mean_7d: z.coerce.number().nullable(),
  rhr_mean_previous_28d: z.coerce.number().nullable(),
  rr_mean_30d: z.coerce.number().nullable(),
  rr_sd_30d: z.coerce.number().nullable(),
  respiratory_rate_z_score: z.coerce.number().nullable(),
  rr_baseline_sample_count: z.coerce.number().int(),
  rr_baseline_coverage: z.coerce.number(),
  rr_mean_7d: z.coerce.number().nullable(),
  rr_mean_previous_28d: z.coerce.number().nullable(),
  efficiency_mean_30d: z.coerce.number().nullable(),
  efficiency_sd_30d: z.coerce.number().nullable(),
  efficiency_z_score: z.coerce.number().nullable(),
  efficiency_baseline_sample_count: z.coerce.number().int(),
  efficiency_baseline_coverage: z.coerce.number(),
  efficiency_mean_7d: z.coerce.number().nullable(),
  efficiency_mean_previous_28d: z.coerce.number().nullable(),
});

type RecoveryBaselineRow = z.infer<typeof recoveryBaselineRowSchema>;

const recoveryBaselineSelect = `SELECT
  toString(recovery.date) AS date,
  recovery.hrv AS hrv,
  recovery.resting_hr AS resting_hr,
  recovery.respiratory_rate AS respiratory_rate,
  recovery.efficiency_pct AS efficiency_pct,
  recovery.hrv_mean_30d AS hrv_mean_30d,
  recovery.hrv_sd_30d AS hrv_sd_30d,
  recovery.hrv_z_score AS hrv_z_score,
  recovery.hrv_baseline_sample_count AS hrv_baseline_sample_count,
  recovery.hrv_baseline_coverage AS hrv_baseline_coverage,
  recovery.hrv_mean_7d AS hrv_mean_7d,
  recovery.hrv_mean_previous_28d AS hrv_mean_previous_28d,
  recovery.rhr_mean_30d AS rhr_mean_30d,
  recovery.rhr_sd_30d AS rhr_sd_30d,
  recovery.resting_hr_z_score AS resting_hr_z_score,
  recovery.rhr_baseline_sample_count AS rhr_baseline_sample_count,
  recovery.rhr_baseline_coverage AS rhr_baseline_coverage,
  recovery.rhr_mean_7d AS rhr_mean_7d,
  recovery.rhr_mean_previous_28d AS rhr_mean_previous_28d,
  recovery.rr_mean_30d AS rr_mean_30d,
  recovery.rr_sd_30d AS rr_sd_30d,
  recovery.respiratory_rate_z_score AS respiratory_rate_z_score,
  recovery.rr_baseline_sample_count AS rr_baseline_sample_count,
  recovery.rr_baseline_coverage AS rr_baseline_coverage,
  recovery.rr_mean_7d AS rr_mean_7d,
  recovery.rr_mean_previous_28d AS rr_mean_previous_28d,
  recovery.efficiency_mean_30d AS efficiency_mean_30d,
  recovery.efficiency_sd_30d AS efficiency_sd_30d,
  recovery.efficiency_z_score AS efficiency_z_score,
  recovery.efficiency_baseline_sample_count AS efficiency_baseline_sample_count,
  recovery.efficiency_baseline_coverage AS efficiency_baseline_coverage,
  recovery.efficiency_mean_7d AS efficiency_mean_7d,
  recovery.efficiency_mean_previous_28d AS efficiency_mean_previous_28d`;

export const dailyRecoveryBaselineSchema = z.object({
  date: dateStringSchema,
  metrics: z.array(baselineRelativeMetricSchema),
});

export type DailyRecoveryBaseline = z.infer<typeof dailyRecoveryBaselineSchema>;

const recoveryMetricOrder = [
  "hrv",
  "resting_heart_rate",
  "respiratory_rate",
  "sleep_efficiency",
] as const;

function buildMetrics(row: RecoveryBaselineRow): BaselineRelativeMetric[] {
  return [
    buildBaselineRelativeMetric({
      metric: "hrv",
      label: "Heart Rate Variability (HRV)",
      value: row.hrv,
      baselineMean: row.hrv_mean_30d,
      baselineStandardDeviation: row.hrv_sd_30d,
      zScore: row.hrv_z_score,
      baselineSampleCount: row.hrv_baseline_sample_count,
      baselineCoverage: row.hrv_baseline_coverage,
      recentMean: row.hrv_mean_7d,
      comparisonMean: row.hrv_mean_previous_28d,
    }),
    buildBaselineRelativeMetric({
      metric: "resting_heart_rate",
      label: "Resting Heart Rate",
      value: row.resting_hr,
      baselineMean: row.rhr_mean_30d,
      baselineStandardDeviation: row.rhr_sd_30d,
      zScore: row.resting_hr_z_score,
      baselineSampleCount: row.rhr_baseline_sample_count,
      baselineCoverage: row.rhr_baseline_coverage,
      recentMean: row.rhr_mean_7d,
      comparisonMean: row.rhr_mean_previous_28d,
    }),
    buildBaselineRelativeMetric({
      metric: "respiratory_rate",
      label: "Respiratory Rate",
      value: row.respiratory_rate,
      baselineMean: row.rr_mean_30d,
      baselineStandardDeviation: row.rr_sd_30d,
      zScore: row.respiratory_rate_z_score,
      baselineSampleCount: row.rr_baseline_sample_count,
      baselineCoverage: row.rr_baseline_coverage,
      recentMean: row.rr_mean_7d,
      comparisonMean: row.rr_mean_previous_28d,
    }),
    buildBaselineRelativeMetric({
      metric: "sleep_efficiency",
      label: "Sleep Efficiency",
      value: row.efficiency_pct,
      baselineMean: row.efficiency_mean_30d,
      baselineStandardDeviation: row.efficiency_sd_30d,
      zScore: row.efficiency_z_score,
      baselineSampleCount: row.efficiency_baseline_sample_count,
      baselineCoverage: row.efficiency_baseline_coverage,
      recentMean: row.efficiency_mean_7d,
      comparisonMean: row.efficiency_mean_previous_28d,
    }),
  ];
}

export function latestRecoveryBaselineMetrics(
  rows: DailyRecoveryBaseline[],
): BaselineRelativeMetric[] {
  return recoveryMetricOrder.flatMap((metricKey) => {
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const metric = rows[rowIndex]?.metrics.find(
        (candidate) => candidate.metric === metricKey && candidate.value != null,
      );
      if (metric) return [metric];
    }
    return [];
  });
}

export class RecoveryBaselineRepository {
  readonly #accessWindow: AccessWindow | undefined;
  readonly #userId: string;
  readonly #sensorStore: Pick<ActivitySensorStore, "query">;

  constructor(
    userId: string,
    sensorStore: Pick<ActivitySensorStore, "query">,
    accessWindow?: AccessWindow,
  ) {
    this.#accessWindow = accessWindow;
    this.#userId = userId;
    this.#sensorStore = sensorStore;
  }

  async listRange(
    startDate: string,
    endDate: string,
    queryOptions?: ActivitySensorQueryOptions,
  ): Promise<DailyRecoveryBaseline[]> {
    const rows = await this.#sensorStore.query(
      recoveryBaselineRowSchema,
      `${recoveryBaselineSelect}
      FROM analytics.daily_recovery AS recovery FINAL
      WHERE recovery.user_id = {userId:UUID}
        AND recovery.is_deleted = 0
        AND recovery.date >= toDate({startDate:String})
        AND recovery.date <= toDate({endDate:String})
        ${
          this.#accessWindow?.kind === "limited"
            ? `AND recovery.date >= toDate({accessStartDate:String})
        AND recovery.date < toDate({accessEndDateExclusive:String})`
            : ""
        }
      ORDER BY recovery.date ASC`,
      {
        userId: this.#userId,
        startDate,
        endDate,
        ...(this.#accessWindow?.kind === "limited"
          ? {
              accessStartDate: this.#accessWindow.startDate,
              accessEndDateExclusive: this.#accessWindow.endDateExclusive,
            }
          : {}),
      },
      queryOptions,
    );

    return rows.map((row) =>
      dailyRecoveryBaselineSchema.parse({
        date: row.date,
        metrics: buildMetrics(row),
      }),
    );
  }

  async latestMetrics(
    endDate: string,
    queryOptions?: ActivitySensorQueryOptions,
  ): Promise<BaselineRelativeMetric[]> {
    const accessPredicate =
      this.#accessWindow?.kind === "limited"
        ? `AND latest.date >= toDate({accessStartDate:String})
          AND latest.date < toDate({accessEndDateExclusive:String})`
        : "";
    const rows = await this.#sensorStore.query(
      recoveryBaselineRowSchema,
      `${recoveryBaselineSelect}
      FROM analytics.daily_recovery AS recovery FINAL
      WHERE recovery.user_id = {userId:UUID}
        AND recovery.is_deleted = 0
        AND recovery.date <= toDate({endDate:String})
        ${
          this.#accessWindow?.kind === "limited"
            ? `AND recovery.date >= toDate({accessStartDate:String})
        AND recovery.date < toDate({accessEndDateExclusive:String})`
            : ""
        }
        AND recovery.date IN (
          SELECT arrayJoin(
            arrayFilter(
              candidate -> candidate > toDate(0),
              [
                maxIf(latest.date, latest.hrv IS NOT NULL),
                maxIf(latest.date, latest.resting_hr IS NOT NULL),
                maxIf(latest.date, latest.respiratory_rate IS NOT NULL),
                maxIf(latest.date, latest.efficiency_pct IS NOT NULL)
              ]
            )
          )
          FROM analytics.daily_recovery AS latest FINAL
          WHERE latest.user_id = {userId:UUID}
            AND latest.is_deleted = 0
            AND latest.date <= toDate({endDate:String})
            ${accessPredicate}
        )
      ORDER BY recovery.date ASC`,
      {
        userId: this.#userId,
        endDate,
        ...(this.#accessWindow?.kind === "limited"
          ? {
              accessStartDate: this.#accessWindow.startDate,
              accessEndDateExclusive: this.#accessWindow.endDateExclusive,
            }
          : {}),
      },
      queryOptions,
    );

    return latestRecoveryBaselineMetrics(
      rows.map((row) =>
        dailyRecoveryBaselineSchema.parse({
          date: row.date,
          metrics: buildMetrics(row),
        }),
      ),
    );
  }
}
