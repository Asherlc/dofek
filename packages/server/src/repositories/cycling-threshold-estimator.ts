import { fitCriticalPowerWithDiagnostics } from "@dofek/training/power-analysis";
import type {
  CyclingPowerCurveEffort,
  CyclingPowerCurveRepository,
} from "./cycling-power-curve-repository.ts";
import type {
  CyclingThresholdHistoryItem,
  CyclingThresholdRepository,
} from "./cycling-threshold-repository.ts";
import type { UnavailableWeightEvidence, WeightEvidence } from "./nearby-weight.ts";
import type { NearbyWeightRepository } from "./nearby-weight-repository.ts";

export const CYCLING_THRESHOLD_METHODS = [
  "best_supported",
  "recorded_provider",
  "twenty_minute_95_percent",
  "sustained_40_to_70_minutes",
  "critical_power_model",
] as const;

export type CyclingThresholdMethod = (typeof CYCLING_THRESHOLD_METHODS)[number];

export interface CyclingThresholdEstimateInput {
  startDate: string;
  endDate: string;
  method: CyclingThresholdMethod;
  providers: string[];
  modalities: string[];
}

type WeightResult = WeightEvidence | UnavailableWeightEvidence;

export interface CyclingThresholdEstimateResult {
  threshold_watts: number;
  watts_per_kg: number | null;
  watts_per_kg_reason: string | null;
  method: Exclude<CyclingThresholdMethod, "best_supported">;
  classification: "configured" | "provider_recorded" | "estimated";
  confidence: "high" | "moderate" | "limited";
  uncertainty: {
    watts: number | null;
    kind: "not_applicable" | "not_quantifiable" | "model_rmse";
    reason: string | null;
  };
  evidence: {
    threshold_history: CyclingThresholdHistoryItem[];
    efforts: CyclingPowerCurveEffort[];
  };
  relevant_activity_ids: string[];
  assumptions: string[];
  model: {
    cp_watts: number;
    w_prime_joules: number;
    r2: number;
    rmse_watts: number;
    residuals: Array<{
      duration_seconds: number;
      observed_watts: number;
      predicted_watts: number;
      residual_watts: number;
    }>;
  } | null;
}

export interface CyclingThresholdEstimateResponse {
  start_date: string;
  end_date: string;
  requested_method: CyclingThresholdMethod;
  result: CyclingThresholdEstimateResult | null;
  unavailable_reason: string | null;
  weight: WeightResult;
}

interface EstimatorDependencies {
  powerCurve: Pick<CyclingPowerCurveRepository, "listRange">;
  thresholds: Pick<CyclingThresholdRepository, "getApplicableConfiguredFtp" | "listHistory">;
  nearbyWeight: Pick<NearbyWeightRepository, "getForDate">;
}

function wattsPerKg(
  watts: number,
  weight: WeightResult,
): { watts_per_kg: number | null; watts_per_kg_reason: string | null } {
  if (weight.value_kg === null) {
    return { watts_per_kg: null, watts_per_kg_reason: weight.reason };
  }
  return {
    watts_per_kg: Math.round((watts / weight.value_kg) * 1000) / 1000,
    watts_per_kg_reason: null,
  };
}

function activityIds(efforts: CyclingPowerCurveEffort[]): string[] {
  return [...new Set(efforts.map((effort) => effort.activity_id))];
}

function effortConfidence(efforts: CyclingPowerCurveEffort[]): "moderate" | "limited" {
  return efforts.every(
    (effort) => effort.power_kind === "direct" && effort.quality.status === "high",
  )
    ? "moderate"
    : "limited";
}

/** Labeled threshold heuristics over canonical power and recorded threshold evidence. */
export class CyclingThresholdEstimator {
  readonly #dependencies: EstimatorDependencies;

  constructor(dependencies: EstimatorDependencies) {
    this.#dependencies = dependencies;
  }

  async estimate(input: CyclingThresholdEstimateInput): Promise<CyclingThresholdEstimateResponse> {
    const weight = await this.#dependencies.nearbyWeight.getForDate(input.endDate);
    let result: CyclingThresholdEstimateResult | null;

    if (input.method === "best_supported") {
      result = await this.#bestSupported(input, weight);
    } else {
      result = await this.#estimateMethod(input.method, input, weight);
    }

    return {
      start_date: input.startDate,
      end_date: input.endDate,
      requested_method: input.method,
      result,
      unavailable_reason: result ? null : this.#unavailableReason(input.method),
      weight,
    };
  }

  async #bestSupported(
    input: CyclingThresholdEstimateInput,
    weight: WeightResult,
  ): Promise<CyclingThresholdEstimateResult | null> {
    const configured = await this.#dependencies.thresholds.getApplicableConfiguredFtp(
      input.endDate,
    );
    if (configured) return this.#recordedResult(configured, weight);

    for (const method of [
      "recorded_provider",
      "sustained_40_to_70_minutes",
      "twenty_minute_95_percent",
      "critical_power_model",
    ] as const) {
      const result = await this.#estimateMethod(method, input, weight);
      if (result) return result;
    }
    return null;
  }

  async #estimateMethod(
    method: Exclude<CyclingThresholdMethod, "best_supported">,
    input: CyclingThresholdEstimateInput,
    weight: WeightResult,
  ): Promise<CyclingThresholdEstimateResult | null> {
    if (method === "recorded_provider") return this.#recordedProvider(input, weight);
    if (method === "twenty_minute_95_percent") return this.#twentyMinute(input, weight);
    if (method === "sustained_40_to_70_minutes") return this.#sustained(input, weight);
    return this.#criticalPower(input, weight);
  }

  async #recordedProvider(
    input: CyclingThresholdEstimateInput,
    weight: WeightResult,
  ): Promise<CyclingThresholdEstimateResult | null> {
    const history = await this.#dependencies.thresholds.listHistory({
      startDate: input.startDate,
      endDate: input.endDate,
      providers: input.providers,
      cursor: null,
      limit: 500,
    });
    const explicitProvider = history.items.find(
      (item) => item.threshold_type === "ftp" && item.value_kind === "provider_recorded",
    );
    if (explicitProvider) return this.#recordedResult(explicitProvider, weight);
    if (input.providers.length > 0) return null;
    const configured = await this.#dependencies.thresholds.getApplicableConfiguredFtp(
      input.endDate,
    );
    return configured ? this.#recordedResult(configured, weight) : null;
  }

  #recordedResult(
    evidence: CyclingThresholdHistoryItem,
    weight: WeightResult,
  ): CyclingThresholdEstimateResult {
    return {
      threshold_watts: evidence.value,
      ...wattsPerKg(evidence.value, weight),
      method: "recorded_provider",
      classification: evidence.value_kind === "configured" ? "configured" : "provider_recorded",
      confidence: evidence.quality.status,
      uncertainty: {
        watts: null,
        kind: "not_applicable",
        reason: "This is a configured or provider-recorded value, not a statistical estimate",
      },
      evidence: { threshold_history: [evidence], efforts: [] },
      relevant_activity_ids: [],
      assumptions: [
        evidence.historical_validity === "effective_dated"
          ? "The configured FTP is applicable on the range end date"
          : "The provider supplied an observation date but no physiological test uncertainty",
      ],
      model: null,
    };
  }

  async #powerEfforts(
    input: CyclingThresholdEstimateInput,
    durationsSeconds: number[],
  ): Promise<CyclingPowerCurveEffort[]> {
    const curve = await this.#dependencies.powerCurve.listRange({
      startDate: input.startDate,
      endDate: input.endDate,
      durationsSeconds,
      modalities: input.modalities,
      providers: input.providers,
      includeActivityCurve: false,
      cursor: null,
      limit: 1,
    });
    return curve.bests;
  }

  async #twentyMinute(
    input: CyclingThresholdEstimateInput,
    weight: WeightResult,
  ): Promise<CyclingThresholdEstimateResult | null> {
    const efforts = await this.#powerEfforts(input, [1200]);
    const effort = efforts.find((candidate) => candidate.duration_seconds === 1200);
    if (!effort) return null;
    const threshold = Math.round(effort.watts * 0.95 * 10) / 10;
    return {
      threshold_watts: threshold,
      ...wattsPerKg(threshold, weight),
      method: "twenty_minute_95_percent",
      classification: "estimated",
      confidence: effortConfidence([effort]),
      uncertainty: {
        watts: null,
        kind: "not_quantifiable",
        reason: "A single 95% heuristic does not provide a statistical uncertainty interval",
      },
      evidence: { threshold_history: [], efforts: [effort] },
      relevant_activity_ids: [effort.activity_id],
      assumptions: [
        "The maximal 20-minute mean power was a representative, well-paced effort",
        "FTP is estimated as 95% of that effort and is not measured FTP",
      ],
      model: null,
    };
  }

  async #sustained(
    input: CyclingThresholdEstimateInput,
    weight: WeightResult,
  ): Promise<CyclingThresholdEstimateResult | null> {
    const efforts = await this.#powerEfforts(input, [2400, 3000, 3600, 4200]);
    const winner = [...efforts].sort((left, right) => right.watts - left.watts)[0];
    if (!winner) return null;
    return {
      threshold_watts: winner.watts,
      ...wattsPerKg(winner.watts, weight),
      method: "sustained_40_to_70_minutes",
      classification: "estimated",
      confidence: effortConfidence(efforts),
      uncertainty: {
        watts: null,
        kind: "not_quantifiable",
        reason: "Observed sustained efforts do not provide a statistical uncertainty interval",
      },
      evidence: { threshold_history: [], efforts },
      relevant_activity_ids: activityIds(efforts),
      assumptions: [
        "The best 40–70-minute mean power was a continuous maximal or near-maximal effort",
        "Sustained power is used as a threshold estimate and is not measured FTP",
      ],
      model: null,
    };
  }

  async #criticalPower(
    input: CyclingThresholdEstimateInput,
    weight: WeightResult,
  ): Promise<CyclingThresholdEstimateResult | null> {
    const efforts = await this.#powerEfforts(input, [120, 180, 300, 420, 600]);
    const model = fitCriticalPowerWithDiagnostics(
      efforts.map((effort) => ({
        durationSeconds: effort.duration_seconds,
        bestPower: effort.watts,
      })),
    );
    if (!model) return null;
    const confidence =
      model.r2 >= 0.98 && effortConfidence(efforts) === "moderate"
        ? "high"
        : model.r2 >= 0.9
          ? "moderate"
          : "limited";
    return {
      threshold_watts: model.cp,
      ...wattsPerKg(model.cp, weight),
      method: "critical_power_model",
      classification: "estimated",
      confidence,
      uncertainty: {
        watts: model.rmse,
        kind: "model_rmse",
        reason: "RMSE describes fit residuals, not physiological or day-to-day uncertainty",
      },
      evidence: { threshold_history: [], efforts },
      relevant_activity_ids: activityIds(efforts),
      assumptions: [
        "The 120–600-second best efforts sufficiently sample the two-parameter power-duration relationship",
        "Critical power is a modeled estimate and is not measured FTP",
      ],
      model: {
        cp_watts: model.cp,
        w_prime_joules: model.wPrime,
        r2: model.r2,
        rmse_watts: model.rmse,
        residuals: model.points.map((point) => ({
          duration_seconds: point.durationSeconds,
          observed_watts: point.observedPower,
          predicted_watts: point.predictedPower,
          residual_watts: point.residualPower,
        })),
      },
    };
  }

  #unavailableReason(method: CyclingThresholdMethod): string {
    if (method === "twenty_minute_95_percent") {
      return "No valid 20-minute cycling power effort exists in the requested range";
    }
    if (method === "sustained_40_to_70_minutes") {
      return "No valid 40–70-minute sustained cycling power effort exists in the requested range";
    }
    if (method === "critical_power_model") {
      return "At least three valid 120–600-second power-duration observations are required";
    }
    if (method === "recorded_provider") {
      return "No effective-dated configured FTP or explicit provider-recorded FTP is available";
    }
    return "No supported recorded or power-duration threshold evidence is available";
  }
}
