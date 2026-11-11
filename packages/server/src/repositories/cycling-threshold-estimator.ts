import type {
  CyclingThresholdEvidence,
  CyclingThresholdRepository,
} from "./cycling-threshold-repository.ts";
import type { UnavailableWeightEvidence, WeightEvidence } from "./nearby-weight.ts";
import type { NearbyWeightRepository } from "./nearby-weight-repository.ts";

export interface CyclingThresholdEstimateInput {
  startDate: string;
  endDate: string;
}
type WeightResult = WeightEvidence | UnavailableWeightEvidence;
export interface CyclingThresholdEstimateResult {
  threshold_watts: number;
  watts_per_kg: number | null;
  watts_per_kg_reason: string | null;
  method: "computed_eftp";
  classification: "estimated";
  uncertainty: { watts: null; kind: "not_quantifiable"; reason: string };
  evidence: CyclingThresholdEvidence;
  relevant_activity_ids: string[];
  assumptions: string[];
}
export interface CyclingThresholdEstimateResponse {
  start_date: string;
  end_date: string;
  result: CyclingThresholdEstimateResult | null;
  unavailable_reason: string | null;
  weight: WeightResult;
}
interface EstimatorDependencies {
  thresholds: Pick<CyclingThresholdRepository, "getAsOf">;
  nearbyWeight: Pick<NearbyWeightRepository, "getForDate">;
}
/** Presents the canonical ongoing estimate with independently observed body weight. */
export class CyclingThresholdEstimator {
  readonly #dependencies: EstimatorDependencies;
  constructor(dependencies: EstimatorDependencies) {
    this.#dependencies = dependencies;
  }
  async estimate(input: CyclingThresholdEstimateInput): Promise<CyclingThresholdEstimateResponse> {
    const [threshold, weight] = await Promise.all([
      this.#dependencies.thresholds.getAsOf(input.endDate),
      this.#dependencies.nearbyWeight.getForDate(input.endDate),
    ]);
    return {
      start_date: input.startDate,
      end_date: input.endDate,
      weight,
      unavailable_reason: threshold.unavailable_reason,
      result:
        threshold.value == null
          ? null
          : {
              threshold_watts: threshold.value,
              watts_per_kg:
                weight.value_kg == null
                  ? null
                  : Math.round((threshold.value / weight.value_kg) * 1000) / 1000,
              watts_per_kg_reason: weight.value_kg == null ? weight.reason : null,
              method: "computed_eftp",
              classification: "estimated",
              uncertainty: threshold.uncertainty,
              evidence: threshold,
              relevant_activity_ids: threshold.evidence_activity_id
                ? [threshold.evidence_activity_id]
                : [],
              assumptions: [
                "Ongoing eFTP uses canonical cycling evidence through the requested end date, including evidence before the displayed range.",
                "This is an independent reference-curve training estimate, not measured FTP or an exact reproduction of Intervals.icu.",
              ],
            },
    };
  }
}
