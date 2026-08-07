import { getEpistemicStatus } from "@dofek/scoring/epistemic-status";
import { circularMovingBlockBootstrapInterval } from "@dofek/stats/block-bootstrap";
import {
  CORRELATION_METRICS,
  CorrelationResult,
  linearRegression,
  MIN_CORRELATION_PAIRS,
  pearsonCorrelation,
} from "@dofek/stats/correlation";
import { formatCorrelationComparison } from "@dofek/stats/correlation-lag";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { JoinedDay } from "../insights/data-join.ts";
import { classifyActivity, joinByDate } from "../insights/data-join.ts";
import {
  activityRowSchema,
  dailyRowSchema,
  nutritionRowSchema,
  sleepRowSchema,
} from "../insights/schemas.ts";
import { spearmanCorrelation } from "../insights/stats.ts";
import {
  clickHouseDateRangePredicate,
  dateWindowStartPredicate,
  type RangeDays,
  rangeDaysParams,
} from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { bodyCompClickHouseSchema, fetchBodyCompProvenanceRows } from "./body-clickhouse.ts";
import { fetchSleepNights } from "./clickhouse-sleep-repository.ts";
import { fetchRestingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

const correlationDailyRowSchema = dailyRowSchema.extend({
  source_providers: z.array(z.string()),
});

const correlationActivityRowSchema = activityRowSchema.extend({
  activity_id: z.string(),
  name: z.string().nullable(),
});

const correlationNutritionRowSchema = nutritionRowSchema.extend({
  contributing_providers: z.array(z.string()),
});

// ── Metric extraction ───────────────────────────────────────────────────

type JoinedDayExtractor = (day: JoinedDay) => number | null;

/** Type-safe extractors keyed by JoinedDay property name. */
const JOINED_DAY_EXTRACTORS: Record<string, JoinedDayExtractor> = {
  resting_hr: (d) => d.resting_hr,
  hrv: (d) => d.hrv,
  spo2_avg: (d) => d.spo2_avg,
  skin_temp_c: (d) => d.skin_temp_c,
  sleep_duration_min: (d) => d.sleep_duration_min,
  deep_min: (d) => d.deep_min,
  rem_min: (d) => d.rem_min,
  sleep_efficiency: (d) => d.sleep_efficiency,
  calories: (d) => d.calories,
  protein_g: (d) => d.protein_g,
  carbs_g: (d) => d.carbs_g,
  fat_g: (d) => d.fat_g,
  fiber_g: (d) => d.fiber_g,
  steps: (d) => d.steps,
  exercise_minutes: (d) => d.exercise_minutes,
  cardio_minutes: (d) => d.cardio_minutes,
  strength_minutes: (d) => d.strength_minutes,
  weight_kg: (d) => d.weight_kg,
  body_fat_pct: (d) => d.body_fat_pct,
  weight_30d_avg: (d) => d.weight_30d_avg,
};

const METRIC_EXTRACTORS = new Map<string, JoinedDayExtractor>(
  CORRELATION_METRICS.map((m) => [m.id, JOINED_DAY_EXTRACTORS[m.joinedDayKey] ?? (() => null)]),
);

const METRIC_LABEL_MAP = new Map(CORRELATION_METRICS.map((m) => [m.id, m.label]));
const METRIC_DOMAIN_MAP = new Map(CORRELATION_METRICS.map((metric) => [metric.id, metric.domain]));

type CorrelationMetricFamily = "recovery" | "sleep" | "nutrition" | "activity" | "body";

export interface CorrelationActivityEvidence {
  id: string;
  activityType: string;
  label: string;
}

export interface CorrelationDayEvidence {
  dailyMetricProviderIds: string[];
  sleepProviderIds: string[];
  nutritionProviderIds: string[];
  bodyProviderIds: string[];
  activities: CorrelationActivityEvidence[];
}

export type CorrelationEvidenceByDate = ReadonlyMap<string, CorrelationDayEvidence>;

export type CorrelationContributor =
  | {
      kind: "record";
      label: string;
      providerIds: string[];
      target: { type: "activity"; activityId: string };
    }
  | {
      kind: "aggregate_inputs";
      label: string;
      providerIds: string[];
      target: { type: "metric_family"; family: CorrelationMetricFamily };
    };

export interface CorrelationObservationValue {
  metricId: string;
  date: string;
  value: number;
  contributors: CorrelationContributor[];
}

export interface CorrelationPairedObservation {
  x: CorrelationObservationValue;
  y: CorrelationObservationValue;
}

export interface CorrelationObservationPage {
  items: CorrelationPairedObservation[];
  totalCount: number;
  nextCursor: string | null;
}

export interface CorrelationMetricOutcome {
  date: string;
  value: number;
  sourceProviderIds: string[];
}

interface CorrelationObservationPagination {
  cursor?: string;
  pageSize: number;
}

const CORRELATION_INTERPRETATION_WARNING =
  "Measurements often persist from one day to the next (autocorrelation) or share a time trend. Either pattern can create a strong correlation without a direct relationship, so use this result to form a hypothesis—not a conclusion.";

export function extractMetricValue(day: JoinedDay, metricId: string): number | null {
  const extractor = METRIC_EXTRACTORS.get(metricId);
  if (!extractor) return null;
  return extractor(day);
}

// ── Computation helpers ─────────────────────────────────────────────────

export interface CorrelationInput {
  metricX: string;
  metricY: string;
  days: RangeDays;
  lag: number;
  endDate?: string;
}

const MAX_DATA_POINTS = 300;

function addCalendarDays(date: string, days: number): string {
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const result: T[] = [];
  for (let i = 0; i < max; i++) {
    const item = arr[Math.floor(i * step)];
    if (item !== undefined) result.push(item);
  }
  return result;
}

interface CorrelationCalendarObservation {
  date: string;
  yDate: string;
  x: number | null;
  y: number | null;
}

interface CorrelationCoverage {
  selectedDayCount: number;
  eligiblePairDayCount: number;
  observedXDayCount: number;
  observedYDayCount: number;
  pairedDayCount: number;
  missingPairDayCount: number;
}

interface CorrelationAnalysis {
  observations: CorrelationCalendarObservation[];
  pairs: Array<{ x: number; y: number; date: string }>;
  coverage: CorrelationCoverage;
}

function buildCorrelationAnalysis(
  joined: JoinedDay[],
  input: CorrelationInput,
): CorrelationAnalysis {
  const { metricX, metricY, lag } = input;
  const daysByDate = new Map(joined.map((day) => [day.date, day]));
  const selectedDates = buildSelectedDates(joined, input);
  const firstEligibleIndex = Math.min(Math.max(-lag, 0), selectedDates.length);
  const lastEligibleIndex = Math.max(0, Math.min(selectedDates.length, selectedDates.length - lag));
  const observations: CorrelationCalendarObservation[] = [];

  for (const date of selectedDates.slice(firstEligibleIndex, lastEligibleIndex)) {
    const dayX = daysByDate.get(date);
    const yDate = addCalendarDays(date, lag);
    const dayY = daysByDate.get(yDate);
    observations.push({
      date,
      yDate,
      x: dayX ? extractMetricValue(dayX, metricX) : null,
      y: dayY ? extractMetricValue(dayY, metricY) : null,
    });
  }

  const pairs = observations.flatMap((observation) =>
    observation.x === null || observation.y === null
      ? []
      : [{ x: observation.x, y: observation.y, date: observation.date }],
  );
  const pairedDayCount = pairs.length;
  const eligiblePairDayCount = observations.length;

  return {
    observations,
    pairs,
    coverage: {
      selectedDayCount: selectedDates.length,
      eligiblePairDayCount,
      observedXDayCount: observations.filter((observation) => observation.x !== null).length,
      observedYDayCount: observations.filter((observation) => observation.y !== null).length,
      pairedDayCount,
      missingPairDayCount: eligiblePairDayCount - pairedDayCount,
    },
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function emptyDayEvidence(): CorrelationDayEvidence {
  return {
    dailyMetricProviderIds: [],
    sleepProviderIds: [],
    nutritionProviderIds: [],
    bodyProviderIds: [],
    activities: [],
  };
}

function dayEvidence(
  evidenceByDate: Map<string, CorrelationDayEvidence>,
  date: string,
): CorrelationDayEvidence {
  const existing = evidenceByDate.get(date);
  if (existing) return existing;
  const created = emptyDayEvidence();
  evidenceByDate.set(date, created);
  return created;
}

function sleepWakeDate(startedAt: string, durationMinutes: number | null): string {
  const wakeDate = new Date(startedAt);
  if (durationMinutes !== null) wakeDate.setMinutes(wakeDate.getMinutes() + durationMinutes);
  return wakeDate.toISOString().slice(0, 10);
}

function providerIdsForMetric(
  metricId: string,
  date: string,
  evidenceByDate: CorrelationEvidenceByDate,
): string[] {
  const evidence = evidenceByDate.get(date);
  if (["hrv", "spo2", "skin_temp", "steps"].includes(metricId)) {
    return evidence?.dailyMetricProviderIds ?? [];
  }
  if (["sleep_duration", "deep_sleep", "rem_sleep", "sleep_efficiency"].includes(metricId)) {
    return evidence?.sleepProviderIds ?? [];
  }
  if (["calories", "protein", "carbs", "fat", "fiber"].includes(metricId)) {
    return evidence?.nutritionProviderIds ?? [];
  }
  if (metricId === "weight_30d") {
    const startDate = addCalendarDays(date, -29);
    return uniqueSorted(
      [...evidenceByDate.entries()].flatMap(([evidenceDate, dayEvidence]) =>
        evidenceDate >= startDate && evidenceDate <= date ? dayEvidence.bodyProviderIds : [],
      ),
    );
  }
  if (metricId === "weight" || metricId === "body_fat") {
    return evidence?.bodyProviderIds ?? [];
  }
  return [];
}

function activityContributors(
  metricId: string,
  date: string,
  evidenceByDate: CorrelationEvidenceByDate,
): CorrelationContributor[] {
  const activities = evidenceByDate.get(date)?.activities ?? [];
  const contributingActivities = activities.filter((activity) => {
    if (metricId === "exercise_duration") return true;
    if (metricId === "cardio_duration") return classifyActivity(activity.activityType) === "cardio";
    if (metricId === "strength_duration") {
      return classifyActivity(activity.activityType) === "strength";
    }
    return false;
  });

  return contributingActivities.map((activity) => ({
    kind: "record" as const,
    label: activity.label,
    providerIds: [],
    target: { type: "activity" as const, activityId: activity.id },
  }));
}

function aggregateInputLabel(metricId: string, family: CorrelationMetricFamily): string {
  if (metricId === "weight_30d") return "30-day body measurement inputs";
  if (family === "recovery") return "Daily recovery aggregate inputs";
  if (family === "sleep") return "Selected sleep-session input";
  if (family === "nutrition") return "Canonical daily nutrition inputs";
  if (family === "activity") return "Daily activity aggregate inputs";
  return "Body measurement inputs";
}

function contributorsForMetric(
  metricId: string,
  date: string,
  evidenceByDate: CorrelationEvidenceByDate,
): CorrelationContributor[] {
  if (
    metricId === "exercise_duration" ||
    metricId === "cardio_duration" ||
    metricId === "strength_duration"
  ) {
    const contributors = activityContributors(metricId, date, evidenceByDate);
    if (contributors.length > 0) return contributors;
  }

  const family = METRIC_DOMAIN_MAP.get(metricId);
  if (!family) return [];
  return [
    {
      kind: "aggregate_inputs",
      label: aggregateInputLabel(metricId, family),
      providerIds: providerIdsForMetric(metricId, date, evidenceByDate),
      target: { type: "metric_family", family },
    },
  ];
}

export function buildCorrelationObservationPage(
  joined: JoinedDay[],
  input: CorrelationInput,
  evidenceByDate: CorrelationEvidenceByDate,
  pagination: CorrelationObservationPagination,
): CorrelationObservationPage {
  const analysis = buildCorrelationAnalysis(joined, input);
  const items: CorrelationPairedObservation[] = [];
  let hasMore = false;
  let pageCursor: string | null = null;
  const totalCount = analysis.observations.reduceRight((count, observation) => {
    if (observation.x === null || observation.y === null) return count;
    const nextCount = count + 1;
    if (pagination.cursor !== undefined && observation.date >= pagination.cursor) return nextCount;
    if (items.length >= pagination.pageSize) {
      hasMore = true;
      return nextCount;
    }
    items.push({
      x: {
        metricId: input.metricX,
        date: observation.date,
        value: observation.x,
        contributors: contributorsForMetric(input.metricX, observation.date, evidenceByDate),
      },
      y: {
        metricId: input.metricY,
        date: observation.yDate,
        value: observation.y,
        contributors: contributorsForMetric(input.metricY, observation.yDate, evidenceByDate),
      },
    });
    pageCursor = observation.date;
    return nextCount;
  }, 0);
  return {
    items,
    totalCount,
    nextCursor: hasMore ? pageCursor : null,
  };
}

function buildSelectedDates(joined: JoinedDay[], input: CorrelationInput): string[] {
  const sortedDates = joined.map((day) => day.date).sort((a, b) => a.localeCompare(b));
  const endDate = input.endDate ?? sortedDates.at(-1);
  if (!endDate) return [];

  const startDate =
    input.days === null ? sortedDates[0] : addCalendarDays(endDate, -(input.days - 1));
  if (!startDate) return [];

  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addCalendarDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

export function computeCorrelation(joined: JoinedDay[], input: CorrelationInput) {
  const { metricX, metricY, lag } = input;
  const analysis = buildCorrelationAnalysis(joined, input);
  const pairCount = analysis.pairs.length;

  if (pairCount < MIN_CORRELATION_PAIRS) {
    const additionalSamplesRequired = MIN_CORRELATION_PAIRS - pairCount;
    return {
      availability: "insufficient" as const,
      epistemicStatus: getEpistemicStatus("unavailable"),
      dataPoints: analysis.pairs,
      sampleCount: pairCount,
      additionalSamplesRequired,
      insight: `Insufficient data to analyze the relationship between ${METRIC_LABEL_MAP.get(metricX) ?? metricX} and ${METRIC_LABEL_MAP.get(metricY) ?? metricY} (only ${pairCount} overlapping data ${pairCount === 1 ? "point" : "points"}; ${additionalSamplesRequired} more ${additionalSamplesRequired === 1 ? "sample is" : "samples are"} required).`,
      confidenceLevel: "insufficient" as const,
      correlationColor: "#71717a",
    };
  }

  const xs = analysis.pairs.map((pair) => pair.x);
  const ys = analysis.pairs.map((pair) => pair.y);

  // Spearman
  const spearman = spearmanCorrelation(xs, ys);

  // Pearson
  const pearson = pearsonCorrelation(xs, ys);

  // Linear regression
  const regression = linearRegression(xs, ys);

  // Stats
  const xStats = computeStats(xs);
  const yStats = computeStats(ys);

  // Wrap Spearman result in CorrelationResult for derived properties
  const spearmanResult = new CorrelationResult(spearman.rho, spearman.pValue, pairCount);

  // Insight text
  const xLabel = (METRIC_LABEL_MAP.get(metricX) ?? metricX).toLowerCase();
  const yLabel = (METRIC_LABEL_MAP.get(metricY) ?? metricY).toLowerCase();
  const insight = spearmanResult.generateInsight({ xLabel, yLabel, lag });

  return {
    availability: "available" as const,
    epistemicStatus: getEpistemicStatus("associated"),
    spearmanRho: spearman.rho,
    spearmanPValue: spearman.pValue,
    pearsonR: pearson.r,
    pearsonPValue: pearson.pValue,
    regression,
    dataPoints: downsample(analysis.pairs, MAX_DATA_POINTS),
    sampleCount: pairCount,
    xStats,
    yStats,
    insight,
    confidenceLevel: spearmanResult.confidence,
    correlationColor: spearmanResult.color,
  };
}

export function computeCorrelationV2(joined: JoinedDay[], input: CorrelationInput) {
  const { metricX, metricY, lag } = input;
  const analysis = buildCorrelationAnalysis(joined, input);
  const pairCount = analysis.pairs.length;

  if (pairCount < MIN_CORRELATION_PAIRS) {
    const additionalSamplesRequired = MIN_CORRELATION_PAIRS - pairCount;
    return {
      analysisVersion: 2 as const,
      availability: "insufficient" as const,
      epistemicStatus: getEpistemicStatus("unavailable"),
      dataPoints: analysis.pairs,
      sampleCount: pairCount,
      additionalSamplesRequired,
      coverage: analysis.coverage,
      uncertainty: unavailableUncertainty(analysis.observations.length, "insufficient_pairs"),
      insight: `Insufficient data to describe the relationship between ${METRIC_LABEL_MAP.get(metricX) ?? metricX} and ${METRIC_LABEL_MAP.get(metricY) ?? metricY} (only ${pairCount} paired calendar ${pairCount === 1 ? "day" : "days"}; ${additionalSamplesRequired} more ${additionalSamplesRequired === 1 ? "is" : "are"} required).`,
      interpretationWarning: CORRELATION_INTERPRETATION_WARNING,
    };
  }

  const xs = analysis.pairs.map((pair) => pair.x);
  const ys = analysis.pairs.map((pair) => pair.y);
  const spearman = spearmanCorrelation(xs, ys);
  const spearmanRho = Number.isFinite(spearman.rho)
    ? Math.max(-1, Math.min(1, spearman.rho))
    : null;
  const regressionResult = linearRegression(xs, ys);
  const xStats = computeStats(xs);
  const yStats = computeStats(ys);
  const regression =
    xStats.stddev === 0
      ? { slope: null, intercept: null, rSquared: null }
      : {
          slope: regressionResult.slope,
          intercept: regressionResult.intercept,
          rSquared: regressionResult.rSquared,
        };
  const xLabel = (METRIC_LABEL_MAP.get(metricX) ?? metricX).toLowerCase();
  const yLabel = (METRIC_LABEL_MAP.get(metricY) ?? metricY).toLowerCase();
  const insight =
    spearmanRho === null
      ? `The relationship between ${xLabel} and ${yLabel} could not be estimated because one metric did not vary across the paired calendar days (n = ${pairCount}).`
      : `${formatCorrelationComparison({ xLabel, yLabel, lag })}: Spearman rho = ${spearmanRho.toFixed(2)} across ${pairCount} paired calendar days.`;
  const uncertainty = computeUncertainty(analysis.observations);

  return {
    analysisVersion: 2 as const,
    availability: "available" as const,
    epistemicStatus: getEpistemicStatus("associated"),
    spearmanRho,
    regression,
    dataPoints: downsample(analysis.pairs, MAX_DATA_POINTS),
    sampleCount: pairCount,
    coverage: analysis.coverage,
    uncertainty,
    xStats,
    yStats,
    insight,
    interpretationWarning: CORRELATION_INTERPRETATION_WARNING,
  };
}

function computeUncertainty(observations: CorrelationCalendarObservation[]) {
  return circularMovingBlockBootstrapInterval(observations, (sample) => {
    const pairs = sample.filter(
      (
        observation,
      ): observation is CorrelationCalendarObservation & {
        x: number;
        y: number;
      } => observation.x !== null && observation.y !== null,
    );
    if (pairs.length < MIN_CORRELATION_PAIRS) return null;
    const result = spearmanCorrelation(
      pairs.map((pair) => pair.x),
      pairs.map((pair) => pair.y),
    );
    return Number.isFinite(result.rho) ? Math.max(-1, Math.min(1, result.rho)) : null;
  });
}

function unavailableUncertainty(
  observationCount: number,
  reason: "degenerate_input" | "insufficient_pairs",
) {
  return {
    availability: "unavailable" as const,
    method: "circular_moving_block_bootstrap" as const,
    level: 0.95 as const,
    blockLength: Math.ceil(Math.cbrt(observationCount)),
    requestedReplicateCount: 2_000 as const,
    attemptedReplicateCount: 0,
    validReplicateCount: 0,
    reason,
  };
}

export function computeStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const valueCount = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / valueCount;
  const min = sorted[0] ?? 0;
  const max = sorted[valueCount - 1] ?? 0;
  const median =
    valueCount % 2 === 0
      ? ((sorted[valueCount / 2 - 1] ?? 0) + (sorted[valueCount / 2] ?? 0)) / 2
      : (sorted[Math.floor(valueCount / 2)] ?? 0);
  const variance =
    sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (valueCount > 1 ? valueCount - 1 : 1);
  const stddev = Math.sqrt(variance);
  return { mean, median, stddev, min, max, n: valueCount };
}

export function emptyStats() {
  return { mean: 0, median: 0, stddev: 0, min: 0, max: 0, n: 0 };
}

// ── Repository ──────────────────────────────────────────────────────────

export class CorrelationRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore?: Pick<ActivitySensorStore, "query">;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone = "UTC",
    sensorStore?: Pick<ActivitySensorStore, "query">,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  getMetrics() {
    return CORRELATION_METRICS.map(
      ({ id, label, unit, domain, description, availabilityDescription }) => ({
        id,
        label,
        unit,
        domain,
        description,
        availabilityDescription,
      }),
    );
  }

  async listMetricOutcomes(
    metricId: string,
    days: RangeDays,
    endDate: string,
  ): Promise<CorrelationMetricOutcome[]> {
    const { joined, evidenceByDate } = await this.#loadCorrelationData(days, endDate);
    return joined.flatMap((day) => {
      const value = extractMetricValue(day, metricId);
      if (value === null) return [];
      return [
        {
          date: day.date,
          value,
          sourceProviderIds: uniqueSorted(
            contributorsForMetric(metricId, day.date, evidenceByDate).flatMap(
              (contributor) => contributor.providerIds,
            ),
          ),
        },
      ];
    });
  }

  async compute(metricX: string, metricY: string, days: RangeDays, lag: number, endDate: string) {
    const joined = await this.#loadJoinedDays(days, endDate);
    return computeCorrelation(joined, {
      metricX,
      metricY,
      days,
      lag,
      endDate,
    });
  }

  async computeV2(metricX: string, metricY: string, days: RangeDays, lag: number, endDate: string) {
    const joined = await this.#loadJoinedDays(days, endDate);
    return computeCorrelationV2(joined, {
      metricX,
      metricY,
      days,
      lag,
      endDate,
    });
  }

  async listObservations(
    metricX: string,
    metricY: string,
    days: RangeDays,
    lag: number,
    endDate: string,
    pagination: { cursor?: string; pageSize: number },
  ): Promise<CorrelationObservationPage> {
    const { joined, evidenceByDate } = await this.#loadCorrelationData(days, endDate);
    return buildCorrelationObservationPage(
      joined,
      { metricX, metricY, days, lag, endDate },
      evidenceByDate,
      pagination,
    );
  }

  async #loadJoinedDays(days: RangeDays, effectiveEndDate: string): Promise<JoinedDay[]> {
    return (await this.#loadCorrelationData(days, effectiveEndDate)).joined;
  }

  async #loadCorrelationData(
    days: RangeDays,
    effectiveEndDate: string,
  ): Promise<{ joined: JoinedDay[]; evidenceByDate: CorrelationEvidenceByDate }> {
    const sensorStore = this.#requireSensorStore();
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate: effectiveEndDate,
      days,
    });
    const [metrics, sleepResult, activities, nutrition, bodyComp] = await Promise.all([
      executeWithSchema(
        this.#db,
        correlationDailyRowSchema,
        sql`WITH ${restingHeartRateCte}
            SELECT
              dm.date,
              drhr.resting_hr,
              dm.hrv,
              dm.spo2_avg,
              dm.steps,
              dm.skin_temp_c,
              dm.source_providers
	            FROM fitness.v_daily_metrics dm
	            LEFT JOIN resting_heart_rate drhr
	              ON drhr.date = dm.date
            WHERE dm.user_id = ${this.#userId}
              ${dateWindowStartPredicate(sql`dm.date`, effectiveEndDate, days)}
              AND dm.date <= ${effectiveEndDate}::date
            ORDER BY dm.date ASC`,
      ),
      fetchSleepNights({
        sensorStore,
        userId: this.#userId,
        timezone: this.#timezone,
        endDate: effectiveEndDate,
        days,
        order: "asc",
      }).then((evidenceRows) => ({
        evidenceRows,
        joinedRows: evidenceRows.map((row) =>
          sleepRowSchema.parse({
            started_at: row.started_at,
            duration_minutes: row.duration_minutes,
            deep_minutes: row.deep_minutes,
            rem_minutes: row.rem_minutes,
            light_minutes: row.light_minutes,
            awake_minutes: row.awake_minutes,
            efficiency_pct: row.efficiency_pct,
            is_nap: false,
          }),
        ),
      })),
      sensorStore.query(
        correlationActivityRowSchema,
        `SELECT
           toString(activity_id) AS activity_id,
           toString(toDate(toTimeZone(started_at, {timezone:String}))) AS date,
           started_at,
           ended_at,
           canonical_type,
           name
         FROM analytics.activity_summary
         WHERE user_id = {userId:UUID}
           ${clickHouseDateRangePredicate({
             expression: "toDate(toTimeZone(started_at, {timezone:String}))",
             days,
           })}
           AND toDate(toTimeZone(started_at, {timezone:String})) <= toDate({endDate:String})
         ORDER BY started_at ASC`,
        {
          userId: this.#userId,
          timezone: this.#timezone,
          endDate: effectiveEndDate,
          ...rangeDaysParams(days),
        },
      ),
      executeWithSchema(
        this.#db,
        correlationNutritionRowSchema,
        sql`SELECT
              date,
              calories,
              protein_g,
              carbs_g,
              fat_g,
              fiber_g,
              water_ml,
              contributing_providers
            FROM fitness.v_nutrition_daily
            WHERE user_id = ${this.#userId}
              AND resolution_status = 'available'
              ${dateWindowStartPredicate(sql`date`, effectiveEndDate, days)}
              AND date <= ${effectiveEndDate}::date
            ORDER BY date ASC`,
      ),
      fetchBodyCompProvenanceRows(
        sensorStore,
        this.#userId,
        this.#timezone,
        effectiveEndDate,
        days,
      ),
    ]);

    const joined = joinByDate(
      metrics.map((row) => dailyRowSchema.parse(row)),
      sleepResult.joinedRows,
      activities,
      nutrition.map((row) => nutritionRowSchema.parse(row)),
      bodyComp.map((row) => bodyCompClickHouseSchema.parse(row)),
      {
        minDailyCalories: 1200,
      },
    );

    const evidenceByDate = new Map<string, CorrelationDayEvidence>();
    for (const row of metrics) {
      dayEvidence(evidenceByDate, row.date).dailyMetricProviderIds = uniqueSorted(
        row.source_providers,
      );
    }
    const selectedSleepDurationByDate = new Map<string, number>();
    for (const row of sleepResult.evidenceRows) {
      const wakeDate = sleepWakeDate(row.started_at, row.duration_minutes);
      const durationMinutes = row.duration_minutes ?? 0;
      if (durationMinutes <= (selectedSleepDurationByDate.get(wakeDate) ?? -1)) continue;
      selectedSleepDurationByDate.set(wakeDate, durationMinutes);
      const providerIds = uniqueSorted([
        ...row.source_providers,
        ...(row.provider_id === null ? [] : [row.provider_id]),
      ]);
      dayEvidence(evidenceByDate, wakeDate).sleepProviderIds = providerIds;
    }
    for (const row of activities) {
      if (row.ended_at === null) continue;
      const evidence = dayEvidence(
        evidenceByDate,
        row.date ?? new Date(row.started_at).toISOString().slice(0, 10),
      );
      evidence.activities.push({
        id: row.activity_id,
        activityType: row.canonical_type,
        label: row.name ?? row.canonical_type,
      });
    }
    for (const row of nutrition) {
      dayEvidence(evidenceByDate, row.date).nutritionProviderIds = uniqueSorted(
        row.contributing_providers,
      );
    }
    for (const row of bodyComp) {
      dayEvidence(evidenceByDate, row.date).bodyProviderIds = uniqueSorted([
        ...row.source_providers,
        row.provider_id,
      ]);
    }

    return { joined, evidenceByDate };
  }

  #requireSensorStore(): Pick<ActivitySensorStore, "query"> {
    if (!this.#sensorStore) {
      throw new Error("ClickHouse activity analytics store is required for correlations");
    }
    return this.#sensorStore;
  }
}
