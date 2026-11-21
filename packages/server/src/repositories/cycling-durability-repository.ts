import { TupleParam } from "@clickhouse/client";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { z } from "zod";
import {
  type AccessWindow,
  clickHouseAccessParams,
  clickHouseAccessPredicate,
} from "../billing/entitlement.ts";
import {
  type CyclingDurabilityEffort,
  type CyclingDurabilityPresentationUnit,
  type CyclingDurabilityResult,
  type CyclingDurabilitySelection,
  cyclingDurabilityResultSchema,
} from "../contracts/cycling-durability.ts";
import type { ChartRange } from "../lib/chart-range.ts";
import { dateWindowEndExclusiveString, dateWindowStartString } from "../lib/date-window.ts";
import { clickHouseActivityLocalDate } from "./activity-local-date.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  MAX_NEARBY_WEIGHT_DAYS,
  selectNearbyWeight,
  type WeightEvidence,
} from "./nearby-weight.ts";
import { loadDirectWeightObservations } from "./nearby-weight-repository.ts";

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];
const OUTDOOR_MODALITIES = ["outdoor", "road", "mountain", "gravel", "cyclocross"];

const dateRowSchema = z.object({ date: z.string() });

const winnerRowSchema = z.object({
  kind: z.enum(["baseline", "after_work"]),
  activity_id: z.string(),
  activity_name: z.string().nullable(),
  activity_date: z.string(),
  started_at: z.string(),
  start_offset_seconds: z.number(),
  end_offset_seconds: z.number(),
  avg_power: z.number(),
  prior_joules: z.number(),
  source_member_id: z.string(),
  provider_id: z.string(),
  source_external_id: z.string().nullable(),
  device_id: z.string().nullable(),
  measurement_kind: z.string(),
  power_provenance: z.enum(["direct", "meter_flag"]),
  observed_samples: z.coerce.number().int(),
  median_sample_interval_seconds: z.number(),
  prefix_and_effort_largest_gap_seconds: z.number(),
  coverage_pct: z.number(),
  pair_weight_kg: z.number(),
  watts_per_kg: z.number(),
});

type WinnerRow = z.infer<typeof winnerRowSchema>;

interface Eligibility {
  activityDate: string;
  predicate: string;
  params: Record<string, unknown>;
}

/**
 * Serves the approved cycling durability comparison. Eligible local dates are
 * resolved first, their nearby weights are matched from accessible canonical
 * measurements, and ClickHouse selects both winners from the bounded candidate
 * arrays. The server only assembles the wire result and its source evidence.
 */
export class CyclingDurabilityRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow | undefined;

  constructor(
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
    accessWindow?: AccessWindow,
  ) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#accessWindow = accessWindow;
  }

  async getComparison(
    range: ChartRange,
    selection: CyclingDurabilitySelection,
    endDate: string,
  ): Promise<CyclingDurabilityResult> {
    const windowStart = range.windowStartString(endDate);
    const eligibility = this.#eligibility(range, selection.durationSeconds, endDate, windowStart);
    const comparisonRange = {
      startDate: windowStart === undefined ? null : dateWindowEndExclusiveString(windowStart),
      endDate,
    };
    const empty = (
      status: CyclingDurabilityResult["status"],
      baseline: CyclingDurabilityEffort | null,
      absoluteWorkCutoffKilojoules: number | null = null,
    ) =>
      this.#result({
        status,
        range: comparisonRange,
        selection,
        presentation: { unit: "watts", difference: 0, absoluteWorkCutoffKilojoules },
        baseline,
        afterWork: null,
        sameEffort: false,
      });

    const dates = await this.#loadDistinctDates(eligibility);
    const matched = await this.#weightsForDates(dates);
    if (matched.weights.length === 0) return empty("no_eligible_power_and_weight", null);

    const winners = await this.#loadWinners(eligibility, matched.weights, selection);
    const baseline = winners.find((winner) => winner.kind === "baseline");
    if (!baseline) return empty("no_eligible_power_and_weight", null);
    const baselineEffort = toEffort(baseline, matched.evidence);
    const absoluteWorkCutoffKilojoules = matched.weights.every(
      ([, kilograms]) => kilograms === baseline.pair_weight_kg,
    )
      ? selection.minimumWorkKilojoulesPerKg * baseline.pair_weight_kg
      : null;
    const afterWork = winners.find((winner) => winner.kind === "after_work");
    if (!afterWork)
      return empty("no_effort_after_work", baselineEffort, absoluteWorkCutoffKilojoules);

    const unit: CyclingDurabilityPresentationUnit =
      baseline.pair_weight_kg === afterWork.pair_weight_kg ? "watts" : "w_per_kg";
    const difference =
      unit === "watts"
        ? baseline.avg_power - afterWork.avg_power
        : baseline.watts_per_kg - afterWork.watts_per_kg;
    const sameEffort =
      baseline.activity_id === afterWork.activity_id &&
      baseline.start_offset_seconds === afterWork.start_offset_seconds &&
      baseline.end_offset_seconds === afterWork.end_offset_seconds;

    return this.#result({
      status: "available",
      range: comparisonRange,
      selection,
      presentation: { unit, difference, absoluteWorkCutoffKilojoules },
      baseline: baselineEffort,
      afterWork: toEffort(afterWork, matched.evidence),
      sameEffort,
    });
  }

  #result(value: CyclingDurabilityResult): CyclingDurabilityResult {
    return cyclingDurabilityResultSchema.parse(value);
  }

  /** Canonical, current, outdoor cycling within the selected and accessible dates. */
  #eligibility(
    range: ChartRange,
    durationSeconds: number,
    endDate: string,
    windowStart: string | undefined,
  ): Eligibility {
    const activityDate = clickHouseActivityLocalDate("activity");
    const params: Record<string, unknown> = {
      userId: this.#userId,
      timezone: this.#timezone,
      durationSeconds,
      endDate,
      activityTypes: CYCLING_TYPES,
      outdoorModalities: OUTDOOR_MODALITIES,
      ...(windowStart === undefined ? {} : { windowStart }),
      ...clickHouseAccessParams(this.#accessWindow, this.#timezone),
    };
    const predicate = `
          effort.user_id = {userId:UUID}
          AND effort.duration_seconds = {durationSeconds:UInt16}
          AND effort.is_deleted = 0
          AND effort.started_at IS NOT NULL
          AND notEmpty(effort.candidates)
          AND activity.is_deleted = 0
          AND has({activityTypes:Array(String)}, activity.canonical_type)
          AND has({outdoorModalities:Array(String)}, activity.modality)
          AND activity.ended_at IS NOT NULL
          AND activity.ended_at <= now()
          AND ${activityDate} <= toDate({endDate:String})
          ${range.clickHouseDateAfterWindowStart({ expression: activityDate })}
          ${clickHouseAccessPredicate(this.#accessWindow, "activity.started_at")}`;
    return { activityDate, predicate, params };
  }

  async #loadDistinctDates(eligibility: Eligibility): Promise<string[]> {
    const rows = await this.#store.query(
      dateRowSchema,
      `/* cycling-durability:dates */
        SELECT DISTINCT toString(${eligibility.activityDate}) AS date
        FROM analytics.cycling_durability_effort AS effort FINAL
        INNER JOIN analytics.deduped_activities AS activity FINAL
          ON activity.activity_id = effort.activity_id
          AND activity.user_id = effort.user_id
        WHERE ${eligibility.predicate}
        ORDER BY date`,
      eligibility.params,
    );
    return rows.map((row) => row.date);
  }

  async #weightsForDates(dates: string[]): Promise<{
    weights: [string, number][];
    evidence: Map<string, WeightEvidence>;
  }> {
    const weights: [string, number][] = [];
    const evidence = new Map<string, WeightEvidence>();
    const firstDate = dates[0];
    const lastDate = dates.at(-1);
    if (firstDate === undefined || lastDate === undefined) return { weights, evidence };
    const observations = await loadDirectWeightObservations(
      this.#store,
      this.#userId,
      this.#timezone,
      firstDate,
      lastDate,
    );
    const access = this.#accessWindow;
    const accessible =
      access?.kind === "limited"
        ? observations.filter(
            (observation) =>
              observation.date >= access.startDate && observation.date < access.endDateExclusive,
          )
        : observations;
    accessible.sort((left, right) => left.date.localeCompare(right.date));
    let firstObservation = 0;
    let lastObservationExclusive = 0;
    for (const date of dates) {
      // Ride dates are ordered. Advance both bounds without changing the weight matching rule.
      const earliest = dateWindowStartString(date, MAX_NEARBY_WEIGHT_DAYS);
      const latest = dateWindowStartString(date, -MAX_NEARBY_WEIGHT_DAYS);
      while (
        firstObservation < accessible.length &&
        (accessible[firstObservation]?.date ?? "") < earliest
      ) {
        firstObservation += 1;
      }
      lastObservationExclusive = Math.max(firstObservation, lastObservationExclusive);
      while (
        lastObservationExclusive < accessible.length &&
        (accessible[lastObservationExclusive]?.date ?? "") <= latest
      ) {
        lastObservationExclusive += 1;
      }
      const weight = selectNearbyWeight(
        date,
        accessible.slice(firstObservation, lastObservationExclusive),
      );
      if (weight.value_kg === null) continue;
      weights.push([date, weight.value_kg]);
      evidence.set(date, weight);
    }
    return { weights, evidence };
  }

  async #loadWinners(
    eligibility: Eligibility,
    weights: [string, number][],
    selection: CyclingDurabilitySelection,
  ): Promise<WinnerRow[]> {
    const qualifies = "candidate.4 >= {workKilojoulesPerKg:Float64} * weight.pair_weight_kg * 1000";
    return this.#store.query(
      winnerRowSchema,
      `/* cycling-durability:selection */
        WITH eligible AS MATERIALIZED (
          SELECT
            toString(effort.activity_id) AS activity_id,
            activity.name AS activity_name,
            toString(${eligibility.activityDate}) AS activity_date,
            formatDateTime(effort.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS started_at,
            candidate.1 AS start_offset_seconds,
            candidate.2 AS end_offset_seconds,
            candidate.3 AS avg_power,
            candidate.4 AS prior_joules,
            candidate.5 AS source_member_id,
            candidate.6 AS provider_id,
            candidate.7 AS source_external_id,
            candidate.8 AS device_id,
            candidate.9 AS measurement_kind,
            candidate.10 AS power_provenance,
            candidate.11 AS observed_samples,
            candidate.12 AS median_sample_interval_seconds,
            candidate.13 AS prefix_and_effort_largest_gap_seconds,
            candidate.14 AS coverage_pct,
            weight.pair_weight_kg AS pair_weight_kg,
            candidate.3 / weight.pair_weight_kg AS watts_per_kg,
            ${qualifies} AS qualifies
          FROM analytics.cycling_durability_effort AS effort FINAL
          INNER JOIN analytics.deduped_activities AS activity FINAL
            ON activity.activity_id = effort.activity_id
            AND activity.user_id = effort.user_id
          ARRAY JOIN effort.candidates AS candidate
          INNER JOIN (
            SELECT
              pair.1 AS pair_date,
              pair.2 AS pair_weight_kg
            FROM (SELECT 1 AS dummy)
            ARRAY JOIN {weights:Array(Tuple(String, Float64))} AS pair
          ) AS weight ON weight.pair_date = toString(${eligibility.activityDate})
          WHERE ${eligibility.predicate}
        )
        SELECT * FROM (
          SELECT 'baseline' AS kind, * FROM eligible
          ORDER BY watts_per_kg DESC, started_at ASC, activity_id ASC, prior_joules DESC, start_offset_seconds ASC
          LIMIT 1
          UNION ALL
          SELECT 'after_work' AS kind, * FROM eligible WHERE qualifies
          ORDER BY watts_per_kg DESC, started_at ASC, activity_id ASC, prior_joules DESC, start_offset_seconds ASC
          LIMIT 1
        ) ORDER BY kind
        SETTINGS enable_materialized_cte = 1`,
      {
        ...eligibility.params,
        weights: weights.map(([date, kilograms]) => new TupleParam([date, kilograms])),
        workKilojoulesPerKg: selection.minimumWorkKilojoulesPerKg,
      },
    );
  }
}

function toEffort(row: WinnerRow, evidence: Map<string, WeightEvidence>): CyclingDurabilityEffort {
  const weight = evidence.get(row.activity_date);
  if (!weight) throw new Error(`Missing matched weight for ${row.activity_date}`);
  const workKilojoules = row.prior_joules / 1000;
  return {
    activityId: row.activity_id,
    activityName: row.activity_name,
    date: row.activity_date,
    startedAt: row.started_at,
    elapsedStartSeconds: row.start_offset_seconds,
    elapsedEndSeconds: row.end_offset_seconds,
    watts: row.avg_power,
    wattsPerKg: row.watts_per_kg,
    workKilojoules,
    workKilojoulesPerKg: workKilojoules / weight.value_kg,
    power: {
      provenance: row.power_provenance,
      sourceMemberId: row.source_member_id,
      deviceId: row.device_id,
      provider: row.provider_id,
      sourceExternalId: row.source_external_id,
      measurementKind: row.measurement_kind,
    },
    coverage: {
      percent: row.coverage_pct,
      observedSamples: row.observed_samples,
      medianSampleIntervalSeconds: row.median_sample_interval_seconds,
      largestGapSeconds: row.prefix_and_effort_largest_gap_seconds,
    },
    weight,
  };
}
