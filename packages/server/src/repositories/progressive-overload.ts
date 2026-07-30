import { circularMovingBlockBootstrapInterval } from "@dofek/stats/block-bootstrap";
import { linearRegression } from "@dofek/stats/correlation";
import type {
  ProgressiveOverloadRow,
  ProgressiveOverloadTrend,
  ProgressiveOverloadUncertainty,
} from "../contracts/progressive-overload.ts";

export interface ProgressiveOverloadObservation {
  week: string;
  totalVolumeKg: number;
}

const MILLISECONDS_PER_WEEK = 7 * 24 * 60 * 60 * 1_000;
const MINIMUM_UNCERTAINTY_OBSERVATIONS = 4;
const DELOAD_CONTEXT =
  "Recorded volume cannot distinguish a planned deload from missed training or incomplete data.";
const UNCERTAINTY_METADATA = {
  level: 0.95,
  method: "residual_circular_moving_block_bootstrap",
  methodLabel: "95% moving-block interval",
} as const;

function roundToHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function elapsedWeeks(startWeek: string, week: string): number {
  return (
    (new Date(`${week}T00:00:00Z`).getTime() - new Date(`${startWeek}T00:00:00Z`).getTime()) /
    MILLISECONDS_PER_WEEK
  );
}

function trendForSlope(slope: number): ProgressiveOverloadTrend {
  if (slope > 0) return "increasing";
  if (slope < 0) return "decreasing";
  return "stable";
}

function interpretationForTrend(trend: ProgressiveOverloadTrend): string {
  if (trend === "increasing") {
    return "Recorded weekly volume increased over this period. An increase is not inherently good or bad.";
  }
  if (trend === "decreasing") {
    return "Recorded weekly volume decreased over this period. A decrease is not inherently good or bad.";
  }
  return "Recorded weekly volume was stable over this period. Stability is not inherently good or bad.";
}

function estimateUncertainty(
  weekPositions: number[],
  volumes: number[],
  slope: number,
  intercept: number,
): ProgressiveOverloadUncertainty {
  if (volumes.length < MINIMUM_UNCERTAINTY_OBSERVATIONS) {
    return {
      ...UNCERTAINTY_METADATA,
      availability: "unavailable",
      reason: "insufficient_observations",
      statement: `Uncertainty needs at least 4 recorded weeks; this estimate has ${volumes.length}.`,
    };
  }

  const residuals = volumes.map(
    (value, index) => value - (intercept + slope * (weekPositions[index] ?? 0)),
  );
  const residualMean = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  const centeredResiduals = residuals.map((value) => value - residualMean);
  const residualRange = Math.max(...centeredResiduals) - Math.min(...centeredResiduals);
  if (residualRange < Number.EPSILON * Math.max(1, ...volumes)) {
    return {
      ...UNCERTAINTY_METADATA,
      availability: "unavailable",
      reason: "no_residual_variation",
      statement:
        "Uncertainty is unavailable because the recorded weeks follow an exact line; that does not establish certainty.",
    };
  }

  const fitted = weekPositions.map((value) => intercept + slope * value);
  const interval = circularMovingBlockBootstrapInterval(centeredResiduals, (sample) => {
    const bootstrapY = sample.map((residual, index) => (fitted[index] ?? 0) + residual);
    return linearRegression(weekPositions, bootstrapY).slope;
  });
  if (interval.availability === "unavailable") {
    return {
      ...UNCERTAINTY_METADATA,
      availability: "unavailable",
      reason: "insufficient_valid_replicates",
      statement:
        "Uncertainty is unavailable because too few valid bootstrap estimates were produced.",
    };
  }

  return {
    ...UNCERTAINTY_METADATA,
    availability: "available",
    lowerKgPerWeek: roundToHundredths(interval.lower),
    upperKgPerWeek: roundToHundredths(interval.upper),
    statement:
      "The interval reflects variation and short-range dependence among recorded weeks; it does not measure programming intent.",
  };
}

/** Dated weekly exercise volume and its evidence-bounded linear trend. */
export class ProgressiveOverload {
  readonly #exerciseName: string;
  readonly #observations: ProgressiveOverloadObservation[];

  constructor(exerciseName: string, observations: ProgressiveOverloadObservation[]) {
    this.#exerciseName = exerciseName;
    this.#observations = observations;
  }

  toDetail(): ProgressiveOverloadRow {
    const startWeek = this.#observations[0]?.week;
    const endWeek = this.#observations.at(-1)?.week;
    if (!startWeek || !endWeek) {
      throw new Error("Progressive overload requires at least one dated observation");
    }

    const elapsedWeekPositions = this.#observations.map((observation) =>
      elapsedWeeks(startWeek, observation.week),
    );
    const weeklyVolumes = this.#observations.map((observation) => observation.totalVolumeKg);
    const regression = linearRegression(elapsedWeekPositions, weeklyVolumes);
    const slopeKgPerWeek = roundToHundredths(regression.slope);
    const trend = trendForSlope(slopeKgPerWeek);

    return {
      exerciseName: this.#exerciseName,
      observations: this.#observations,
      period: {
        startWeek,
        endWeek,
        observationCount: this.#observations.length,
        elapsedWeekCount: Math.round(elapsedWeeks(startWeek, endWeek)) + 1,
      },
      slopeKgPerWeek,
      trend,
      uncertainty: estimateUncertainty(
        elapsedWeekPositions,
        weeklyVolumes,
        regression.slope,
        regression.intercept,
      ),
      interpretation: interpretationForTrend(trend),
      deloadContext: DELOAD_CONTEXT,
    };
  }
}
