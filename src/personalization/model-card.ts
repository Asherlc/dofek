import {
  MINIMUM_EXPONENTIAL_MOVING_AVERAGE_ABSOLUTE_CORRELATION,
  MINIMUM_EXPONENTIAL_MOVING_AVERAGE_DAYS,
} from "./fit-ewma.ts";
import { MINIMUM_STRESS_DAYS } from "./fit-stress-thresholds.ts";
import type { PersonalizationModelKey, PersonalizedParams } from "./params.ts";

export interface PersonalizationModelCard {
  key: PersonalizationModelKey;
  title: string;
  description: string;
  status: "personalized" | "default";
  lastSuccessfulFitAt: string | null;
  lastFitSummary: string;
  dataWindow: string;
  dataSufficiency: string;
  fitEvidence: string;
  uncertainty: string;
  excludedData: string[];
}

const NO_CALIBRATED_UNCERTAINTY = "No calibrated uncertainty interval is available.";

export function buildPersonalizationModelCards(
  params: PersonalizedParams | null,
): PersonalizationModelCard[] {
  return [buildExponentialMovingAverageCard(params), buildStressThresholdCard(params)];
}

function fitTime(
  params: PersonalizedParams | null,
  key: PersonalizationModelKey,
  personalized: boolean,
): Pick<PersonalizationModelCard, "lastSuccessfulFitAt" | "lastFitSummary"> {
  if (!personalized) {
    return {
      lastSuccessfulFitAt: null,
      lastFitSummary: "No accepted personalized fit",
    };
  }

  const timestamp = params?.successfulFitAt?.[key] ?? null;
  return timestamp
    ? {
        lastSuccessfulFitAt: timestamp,
        lastFitSummary: "Successful fit time recorded",
      }
    : {
        lastSuccessfulFitAt: null,
        lastFitSummary: "Successful fit time unavailable until this model is refit",
      };
}

function buildExponentialMovingAverageCard(
  params: PersonalizedParams | null,
): PersonalizationModelCard {
  const fitted = params?.exponentialMovingAverage ?? null;
  const personalized = fitted !== null;
  return {
    key: "exponentialMovingAverage",
    title: "Training Load Windows",
    description: "How many days of training history are used to compute fitness and fatigue",
    status: personalized ? "personalized" : "default",
    ...fitTime(params, "exponentialMovingAverage", personalized),
    dataWindow: "Past 365 days",
    dataSufficiency: fitted
      ? `${fitted.sampleCount} qualifying days used; minimum ${MINIMUM_EXPONENTIAL_MOVING_AVERAGE_DAYS} days`
      : `No accepted fit; requires at least ${MINIMUM_EXPONENTIAL_MOVING_AVERAGE_DAYS} qualifying days and absolute Pearson correlation of at least ${MINIMUM_EXPONENTIAL_MOVING_AVERAGE_ABSOLUTE_CORRELATION.toFixed(2)}`,
    fitEvidence: fitted
      ? `Pearson correlation: ${fitted.correlation.toFixed(3)}`
      : "No accepted fit statistic is available.",
    uncertainty: NO_CALIBRATED_UNCERTAINTY,
    excludedData: [
      "Days without a nonzero performance observation",
      "Unfinished activities",
      "Activities without average heart rate",
    ],
  };
}

function buildStressThresholdCard(params: PersonalizedParams | null): PersonalizationModelCard {
  const fitted = params?.stressThresholds ?? null;
  const personalized = fitted !== null;
  return {
    key: "stressThresholds",
    title: "Stress Sensitivity",
    description: "How far each threshold is from your usual baseline (in standard deviations)",
    status: personalized ? "personalized" : "default",
    ...fitTime(params, "stressThresholds", personalized),
    dataWindow: "Past 425 days, including rolling-baseline warm-up",
    dataSufficiency: fitted
      ? `${fitted.sampleCount} qualifying days used; minimum ${MINIMUM_STRESS_DAYS} days`
      : `No accepted fit; requires at least ${MINIMUM_STRESS_DAYS} qualifying days`,
    fitEvidence: fitted
      ? "This percentile-based fit does not calculate a goodness-of-fit statistic."
      : "No accepted fit statistic is available.",
    uncertainty: NO_CALIBRATED_UNCERTAINTY,
    excludedData: [
      "Days without heart-rate variability or resting heart rate",
      "Days without nonzero rolling variability",
    ],
  };
}
