import type { z } from "zod";
import {
  comparableEffortMetricsSchema,
  effortTrendEvidenceSchema,
  effortTrendResultSchema,
} from "../mcp/effort-trend-output.ts";
import type {
  PerformanceComparisonInput,
  PerformanceComparisonRepository,
} from "./performance-comparison-repository.ts";
import type { PerformanceEquivalence } from "./performance-comparison-types.ts";
import { EFFORT_IDENTITY_KINDS } from "./repeated-effort-types.ts";
import type {
  FindRepeatedEffortsInput,
  FindRepeatedEffortsOutput,
} from "./repeated-efforts-repository.ts";

type ComparableMetrics = z.infer<typeof comparableEffortMetricsSchema>;
type ComparableMetric = keyof ComparableMetrics;
type TrendResult = z.infer<typeof effortTrendResultSchema>;
type ComparisonResult = Awaited<ReturnType<PerformanceComparisonRepository["compare"]>>;
type ComparisonPerformance = ComparisonResult["performances"][number];

interface ComparisonService {
  compare(input: PerformanceComparisonInput): Promise<ComparisonResult>;
}

interface RepeatedEffortDiscovery {
  find(input: FindRepeatedEffortsInput): Promise<FindRepeatedEffortsOutput>;
}

export interface EffortTrendInput {
  effortId?: string;
  equivalence?: PerformanceEquivalence;
  startDate: string;
  endDate: string;
}

const metrics: readonly ComparableMetric[] = comparableEffortMetricsSchema.keyof().options;

const higherIsBetter = new Set<ComparableMetric>([
  "average_power_watts",
  "normalized_power_watts",
  "power_to_heart_rate_ratio",
  "distance_meters",
  "elevation_gain_meters",
  "climbing_sends",
  "strength_volume_kg_reps",
  "strength_estimated_one_rep_max_kg",
]);
const lowerIsBetter = new Set<ComparableMetric>(["duration_seconds", "moving_duration_seconds"]);
const discoveryStrengths = new Set([
  "exact",
  "strong_inferred",
  "caller_asserted",
  "weak_similarity",
]);
const nonMaximalCaveat =
  "Ordinary workout bests are lower-bound observed capability, not maximal capacity.";

function emptyMetrics(): ComparableMetrics {
  return comparableEffortMetricsSchema.parse(
    Object.fromEntries(metrics.map((metric) => [metric, null])),
  );
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function subtract(value: number | null, comparison: number | null): number | null {
  return value === null || comparison === null ? null : round(value - comparison);
}

function values(performance: ComparisonPerformance): ComparableMetrics {
  const cycling = performance.metrics.cycling;
  const climbing = performance.metrics.climbing;
  const strength = performance.metrics.strength;
  return {
    duration_seconds: performance.duration_seconds,
    moving_duration_seconds:
      performance.moving_duration.status === "available"
        ? performance.moving_duration.seconds
        : null,
    average_power_watts: cycling?.average_power_watts ?? null,
    normalized_power_watts: cycling?.normalized_power_watts ?? null,
    average_heart_rate_bpm: cycling?.average_heart_rate_bpm ?? null,
    average_cadence_rpm: cycling?.average_cadence_rpm ?? null,
    power_to_heart_rate_ratio: cycling?.power_to_heart_rate_ratio ?? null,
    distance_meters: cycling?.distance_meters ?? null,
    elevation_gain_meters: cycling?.elevation_gain_meters ?? null,
    average_temperature_c: performance.metrics.environment.average_temperature_c,
    climbing_attempts: climbing?.attempts_status === "complete" ? climbing.attempts : null,
    climbing_sends: climbing?.outcomes_status === "complete" ? climbing.sends : null,
    strength_volume_kg_reps:
      strength?.volume_status === "complete" ? strength.valid_volume_kg_reps : null,
    strength_estimated_one_rep_max_kg:
      strength?.estimated_one_rep_max_status === "complete"
        ? strength.best_estimated_one_rep_max_kg
        : null,
  };
}

function deltas(current: ComparableMetrics, comparison: ComparableMetrics): ComparableMetrics {
  return comparableEffortMetricsSchema.parse(
    Object.fromEntries(
      metrics.map((metric) => [metric, subtract(current[metric], comparison[metric])]),
    ),
  );
}

function bestValues(rows: ComparableMetrics[]): ComparableMetrics {
  return comparableEffortMetricsSchema.parse(
    Object.fromEntries(
      metrics.map((metric) => {
        const observed = rows
          .map((row) => row[metric])
          .filter((value): value is number => value !== null);
        if (observed.length === 0 || (!higherIsBetter.has(metric) && !lowerIsBetter.has(metric))) {
          return [metric, null];
        }
        return [metric, higherIsBetter.has(metric) ? Math.max(...observed) : Math.min(...observed)];
      }),
    ),
  );
}

function rollingValues(rows: ComparableMetrics[]): ComparableMetrics {
  return comparableEffortMetricsSchema.parse(
    Object.fromEntries(
      metrics.map((metric) => {
        const observed = rows
          .map((row) => row[metric])
          .filter((value): value is number => value !== null);
        return [
          metric,
          observed.length < 3
            ? null
            : round(observed.reduce((sum, value) => sum + value, 0) / observed.length),
        ];
      }),
    ),
  );
}

function hasLimitedSamples(performance: ComparisonPerformance): boolean {
  return (
    performance.metrics.cycling != null &&
    (performance.metrics.cycling.sample_coverage.status !== "available" ||
      performance.metrics.cycling_effort?.quality.status === "limited" ||
      performance.quality.flags.some(
        (flag) => flag.includes("limited") || flag.includes("coverage"),
      ))
  );
}

function directEquivalence(effortId: string): PerformanceEquivalence | null {
  const [kind, ...parts] = effortId.split(":");
  if (!kind || parts.length === 0 || discoveryStrengths.has(parts[0] ?? "")) return null;
  if (kind === "canonical_route") return { kind, value: parts.join(":") };
  const [namespace, ...rest] = parts;
  const value = rest.join(":");
  if (!namespace || !value) return null;
  if (kind === "provider_workout" || kind === "provider_route") {
    return { kind, provider: namespace, value };
  }
  if (kind === "segment" || kind === "climb" || kind === "standardized_test") {
    return { kind, namespace, value };
  }
  return null;
}

function equivalenceFromDiscovery(
  group: FindRepeatedEffortsOutput["groups"][number],
): PerformanceEquivalence {
  const evidence = group.identityEvidence[0];
  if (!evidence) throw new Error("The discovery effort has no identity evidence");
  if (group.kind === "provider_workout" || group.kind === "provider_route") {
    if (!evidence.namespace) throw new Error("The discovery effort has no provider namespace");
    return { kind: group.kind, provider: evidence.namespace, value: evidence.value };
  }
  if (group.kind === "segment" || group.kind === "climb" || group.kind === "standardized_test") {
    if (!evidence.namespace) throw new Error("The discovery effort has no identity namespace");
    return { kind: group.kind, namespace: evidence.namespace, value: evidence.value };
  }
  if (group.kind === "canonical_route") return { kind: group.kind, value: evidence.value };
  if (group.kind === "user_defined_benchmark") return { kind: group.kind, value: evidence.value };
  if (group.kind === "activity_name") {
    const weakSpecification = group.weakSpecification;
    if (!weakSpecification) throw new Error("The discovery effort has no weak-group specification");
    return {
      kind: group.kind,
      canonicalType: weakSpecification.canonicalType,
      value: weakSpecification.normalizedValue,
      asserted: false,
      weakSpecification,
    };
  }
  throw new Error("The discovery effort cannot be converted to a comparison equivalence");
}

/** Projects one identity-aware comparison into chronological, descriptive repeated-effort trends. */
export class EffortTrendRepository {
  readonly #comparison: ComparisonService;
  readonly #discovery: RepeatedEffortDiscovery | null;

  constructor(comparison: ComparisonService, discovery: RepeatedEffortDiscovery | null = null) {
    this.#comparison = comparison;
    this.#discovery = discovery;
  }

  async #resolve(
    input: EffortTrendInput,
  ): Promise<
    Pick<
      PerformanceComparisonInput,
      "equivalence" | "providers" | "modalities" | "discoveryActivityIds"
    >
  > {
    if (input.equivalence) return { equivalence: input.equivalence, providers: [], modalities: [] };
    if (!input.effortId) throw new Error("An effort ID or explicit equivalence is required");
    const direct = directEquivalence(input.effortId);
    if (direct) return { equivalence: direct, providers: [], modalities: [] };
    if (!this.#discovery)
      throw new Error("A discovery effort ID requires the repeated-effort repository");
    const effortKind = EFFORT_IDENTITY_KINDS.find((kind) => input.effortId?.startsWith(`${kind}:`));
    if (!effortKind) throw new Error("The discovery effort ID has an unsupported identity kind");
    const result = await this.#discovery.find({
      startDate: input.startDate,
      endDate: input.endDate,
      minimumRepetitions: 2,
      equivalenceStrength: "weak",
      providers: [],
      modalities: [],
      canonicalTypes: [],
      effortKind,
      effortId: input.effortId,
      limit: 1,
      cursor: null,
    });
    const group = result.groups.find((candidate) => candidate.effortId === input.effortId);
    if (group)
      return {
        equivalence: equivalenceFromDiscovery(group),
        providers: group.discoveryScope.providers,
        modalities: group.discoveryScope.modalities,
        discoveryActivityIds: group.canonicalActivityIds,
      };
    throw new Error("The discovery effort ID was not found in the requested date range");
  }

  async get(input: EffortTrendInput): Promise<TrendResult> {
    if (Boolean(input.effortId) === Boolean(input.equivalence)) {
      throw new Error("Provide exactly one effort ID or explicit equivalence");
    }
    const comparison = await this.#comparison.compare({
      startDate: input.startDate,
      endDate: input.endDate,
      referenceActivityId: null,
      ...(await this.#resolve(input)),
      cursor: null,
      limit: 100,
    });
    const rows = comparison.performances;
    const comparable = rows.map(values);
    const first = comparable[0] ?? emptyMetrics();
    const best = bestValues(comparable);
    const limitedCoverage = rows.some(hasLimitedSamples);
    const caveats = [
      nonMaximalCaveat,
      ...(limitedCoverage ? ["Some repetitions have limited cycling sample coverage"] : []),
      ...(comparison.pagination?.has_more
        ? [
            "Only the first 100 chronological repetitions are included; narrow the date range for a complete trend.",
          ]
        : []),
    ];
    const assumptions = comparison.equivalence.assumptions;
    const evidence: Array<z.infer<typeof effortTrendEvidenceSchema>> = [];
    for (const row of rows) {
      for (const item of row.equivalence_evidence) {
        evidence.push(effortTrendEvidenceSchema.parse(item));
      }
    }
    return effortTrendResultSchema.parse({
      equivalence: comparison.equivalence,
      repetitions: rows.map((performance, index) => {
        const current = comparable[index] ?? emptyMetrics();
        const window = comparable.slice(Math.max(0, index - 2), index + 1);
        const insufficient = window.length < 3;
        const rowCaveats = [
          nonMaximalCaveat,
          ...(hasLimitedSamples(performance)
            ? ["This repetition has limited cycling sample coverage"]
            : []),
          ...(!performance.quality.comparable
            ? ["This repetition has weak identity evidence and is not comparable."]
            : []),
        ];
        return {
          activity_id: performance.activity_id,
          date: performance.date,
          started_at: performance.started_at,
          comparable_metrics: current,
          delta_to_first: deltas(current, first),
          delta_to_previous:
            index === 0 ? emptyMetrics() : deltas(current, comparable[index - 1] ?? emptyMetrics()),
          delta_to_best: deltas(current, best),
          rolling: {
            window_repetitions: 3,
            observation_count: window.length,
            metric_observation_counts: Object.fromEntries(
              metrics.map((metric) => [
                metric,
                window.filter((row) => row[metric] !== null).length,
              ]),
            ),
            comparable_metrics: rollingValues(window),
            status: insufficient ? "insufficient_observations" : "available",
            reason: insufficient
              ? "At least three repetitions are required for a descriptive rolling trend."
              : null,
          },
          quality: performance.quality,
          evidence: [
            {
              evidence_type: "comparison_performance",
              activity_id: performance.activity_id,
              route: performance.route,
              metrics: performance.metrics,
              provenance: performance.provenance,
              identity: performance.identity,
              moving_duration: performance.moving_duration,
            },
            ...performance.equivalence_evidence.map((evidence) =>
              effortTrendEvidenceSchema.parse(evidence),
            ),
          ],
          assumptions: [...assumptions, ...performance.identity.assumptions],
          caveats: rowCaveats,
        };
      }),
      definitions: {
        deltas:
          "Every numeric delta is current repetition minus the named comparison repetition; null means one or both values are unavailable.",
        rolling:
          "Rolling values are trailing three-repetition descriptive means. Each metric requires three non-null observations; missing values remain null and per-metric observation counts explain availability.",
        best: "Best uses lower elapsed/moving duration and higher power, power-to-heart-rate ratio, distance, elevation, climbing sends, strength volume, and estimated one-rep maximum. Heart rate, cadence, temperature, and climbing attempts are descriptive and not ranked.",
      },
      quality: {
        comparable_repetitions: rows.filter((row) => row.quality.comparable).length,
        total_repetitions: rows.length,
      },
      evidence,
      assumptions,
      caveats,
    });
  }
}
