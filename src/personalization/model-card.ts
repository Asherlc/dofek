import {
  MINIMUM_EXPONENTIAL_MOVING_AVERAGE_ABSOLUTE_CORRELATION,
  MINIMUM_EXPONENTIAL_MOVING_AVERAGE_DAYS,
} from "./fit-ewma.ts";
import { MINIMUM_READINESS_CORRELATION, MINIMUM_READINESS_DAYS } from "./fit-readiness-weights.ts";
import { MINIMUM_QUALIFYING_SLEEP_NIGHTS } from "./fit-sleep-target.ts";
import { MINIMUM_STRESS_DAYS } from "./fit-stress-thresholds.ts";
import {
  MINIMUM_TRAINING_IMPULSE_ACTIVITIES,
  MINIMUM_TRAINING_IMPULSE_R_SQUARED,
} from "./fit-trimp.ts";
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
  return [
    buildExponentialMovingAverageCard(params),
    buildReadinessCard(params),
    buildSleepTargetCard(params),
    buildStressThresholdCard(params),
    buildTrainingImpulseCard(params),
  ];
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

function buildReadinessCard(params: PersonalizedParams | null): PersonalizationModelCard {
  const fitted = params?.readinessWeights ?? null;
  const personalized = fitted !== null;
  return {
    key: "readinessWeights",
    title: "Readiness Score Weights",
    description: "How much each factor contributes to your daily readiness score",
    status: personalized ? "personalized" : "default",
    ...fitTime(params, "readinessWeights", personalized),
    dataWindow: "Past 365 days after a 60-day rolling-baseline warm-up",
    dataSufficiency: fitted
      ? `${fitted.sampleCount} qualifying days used; minimum ${MINIMUM_READINESS_DAYS} days`
      : `No accepted fit; requires at least ${MINIMUM_READINESS_DAYS} qualifying days and Pearson correlation of at least ${MINIMUM_READINESS_CORRELATION.toFixed(2)}`,
    fitEvidence: fitted
      ? `Pearson correlation: ${fitted.correlation.toFixed(3)}`
      : "No accepted fit statistic is available.",
    uncertainty: NO_CALIBRATED_UNCERTAINTY,
    excludedData: [
      "Days without heart-rate variability or resting heart rate",
      "Days without stable rolling baselines",
      "Days without a next-day heart-rate variability outcome",
    ],
  };
}

function buildSleepTargetCard(params: PersonalizedParams | null): PersonalizationModelCard {
  const fitted = params?.sleepTarget ?? null;
  const personalized = fitted !== null;
  return {
    key: "sleepTarget",
    title: "Sleep Target",
    description: "The amount of sleep associated with your best recovery",
    status: personalized ? "personalized" : "default",
    ...fitTime(params, "sleepTarget", personalized),
    dataWindow: "Past 365 days; next-day recovery uses up to 60 days of baseline history",
    dataSufficiency: fitted
      ? `${fitted.sampleCount} qualifying nights used; minimum ${MINIMUM_QUALIFYING_SLEEP_NIGHTS} nights`
      : `No accepted fit; requires at least ${MINIMUM_QUALIFYING_SLEEP_NIGHTS} qualifying nights`,
    fitEvidence: fitted
      ? "This average-based fit does not calculate a goodness-of-fit statistic."
      : "No accepted fit statistic is available.",
    uncertainty: NO_CALIBRATED_UNCERTAINTY,
    excludedData: [
      "Naps and shorter duplicate sleep sessions",
      "Sleep sessions without duration",
      "Nights without a next-day heart-rate variability comparison",
      "Nights not followed by above-median heart-rate variability",
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

function buildTrainingImpulseCard(params: PersonalizedParams | null): PersonalizationModelCard {
  const fitted = params?.trainingImpulseConstants ?? null;
  const personalized = fitted !== null;
  return {
    key: "trainingImpulseConstants",
    title: "Heart Rate Effort Model",
    description: "How heart rate intensity translates to training load",
    status: personalized ? "personalized" : "default",
    ...fitTime(params, "trainingImpulseConstants", personalized),
    dataWindow: "All qualifying activities; the power reference uses the past 365 days",
    dataSufficiency: fitted
      ? `${fitted.sampleCount} qualifying activities used; minimum ${MINIMUM_TRAINING_IMPULSE_ACTIVITIES} activities`
      : `No accepted fit; requires at least ${MINIMUM_TRAINING_IMPULSE_ACTIVITIES} qualifying activities and R² of at least ${MINIMUM_TRAINING_IMPULSE_R_SQUARED.toFixed(2)}`,
    fitEvidence: fitted ? `R²: ${fitted.r2.toFixed(3)}` : "No accepted fit statistic is available.",
    uncertainty: NO_CALIBRATED_UNCERTAINTY,
    excludedData: [
      "Activities without heart-rate samples or normalized power",
      "Activities with non-positive duration or power-based training load",
      "Activities whose maximum heart rate is not above resting heart rate",
    ],
  };
}
