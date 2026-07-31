import { describe, expect, it } from "vitest";
import { buildPersonalizationModelCards } from "./model-card.ts";
import type { PersonalizedParams } from "./params.ts";

function personalizedParams(overrides: Partial<PersonalizedParams> = {}): PersonalizedParams {
  return {
    version: 2,
    fittedAt: "2026-07-29T12:00:00.000Z",
    successfulFitAt: {
      exponentialMovingAverage: "2026-07-28T12:00:00.000Z",
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    },
    exponentialMovingAverage: {
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
      sampleCount: 120,
      correlation: 0.842,
    },
    readinessWeights: null,
    sleepTarget: null,
    stressThresholds: null,
    trainingImpulseConstants: null,
    ...overrides,
  };
}

describe("buildPersonalizationModelCards", () => {
  it("describes the complete default evidence contract when no fits exist", () => {
    expect(buildPersonalizationModelCards(null)).toEqual([
      {
        key: "exponentialMovingAverage",
        title: "Training Load Windows",
        description: "How many days of training history are used to compute fitness and fatigue",
        status: "default",
        lastSuccessfulFitAt: null,
        lastFitSummary: "No accepted personalized fit",
        dataWindow: "Past 365 days",
        dataSufficiency:
          "No accepted fit; requires at least 90 qualifying days and absolute Pearson correlation of at least 0.20",
        fitEvidence: "No accepted fit statistic is available.",
        uncertainty: "No calibrated uncertainty interval is available.",
        excludedData: [
          "Days without a nonzero performance observation",
          "Unfinished activities",
          "Activities without average heart rate",
        ],
      },
      {
        key: "readinessWeights",
        title: "Readiness Score Weights",
        description: "How much each factor contributes to your daily readiness score",
        status: "default",
        lastSuccessfulFitAt: null,
        lastFitSummary: "No accepted personalized fit",
        dataWindow: "Past 365 days after a 60-day rolling-baseline warm-up",
        dataSufficiency:
          "No accepted fit; requires at least 60 qualifying days and Pearson correlation of at least 0.15",
        fitEvidence: "No accepted fit statistic is available.",
        uncertainty: "No calibrated uncertainty interval is available.",
        excludedData: [
          "Days without heart-rate variability or resting heart rate",
          "Days without stable rolling baselines",
          "Days without a next-day heart-rate variability outcome",
        ],
      },
      {
        key: "sleepTarget",
        title: "Sleep Target",
        description: "The amount of sleep associated with your best recovery",
        status: "default",
        lastSuccessfulFitAt: null,
        lastFitSummary: "No accepted personalized fit",
        dataWindow: "Past 365 days; next-day recovery uses up to 60 days of baseline history",
        dataSufficiency: "No accepted fit; requires at least 14 qualifying nights",
        fitEvidence: "No accepted fit statistic is available.",
        uncertainty: "No calibrated uncertainty interval is available.",
        excludedData: [
          "Naps and shorter duplicate sleep sessions",
          "Sleep sessions without duration",
          "Nights without a next-day heart-rate variability comparison",
          "Nights not followed by above-median heart-rate variability",
        ],
      },
      {
        key: "stressThresholds",
        title: "Stress Sensitivity",
        description: "How far each threshold is from your usual baseline (in standard deviations)",
        status: "default",
        lastSuccessfulFitAt: null,
        lastFitSummary: "No accepted personalized fit",
        dataWindow: "Past 425 days, including rolling-baseline warm-up",
        dataSufficiency: "No accepted fit; requires at least 60 qualifying days",
        fitEvidence: "No accepted fit statistic is available.",
        uncertainty: "No calibrated uncertainty interval is available.",
        excludedData: [
          "Days without heart-rate variability or resting heart rate",
          "Days without nonzero rolling variability",
        ],
      },
      {
        key: "trainingImpulseConstants",
        title: "Heart Rate Effort Model",
        description: "How heart rate intensity translates to training load",
        status: "default",
        lastSuccessfulFitAt: null,
        lastFitSummary: "No accepted personalized fit",
        dataWindow: "All qualifying activities; the power reference uses the past 365 days",
        dataSufficiency:
          "No accepted fit; requires at least 20 qualifying activities and R² of at least 0.30",
        fitEvidence: "No accepted fit statistic is available.",
        uncertainty: "No calibrated uncertainty interval is available.",
        excludedData: [
          "Activities without heart-rate samples or normalized power",
          "Activities with non-positive duration or power-based training load",
          "Activities whose maximum heart rate is not above resting heart rate",
        ],
      },
    ]);
  });

  it("describes personalized evidence for every fitted model", () => {
    const fittedAt = "2026-07-28T12:00:00.000Z";
    const params = personalizedParams({
      successfulFitAt: {
        exponentialMovingAverage: fittedAt,
        readinessWeights: fittedAt,
        sleepTarget: fittedAt,
        stressThresholds: fittedAt,
        trainingImpulseConstants: fittedAt,
      },
      readinessWeights: {
        hrv: 0.4,
        restingHr: 0.2,
        sleep: 0.25,
        respiratoryRate: 0.15,
        sampleCount: 91,
        correlation: 0.7564,
      },
      sleepTarget: { minutes: 480, sampleCount: 22 },
      stressThresholds: {
        hrvThresholds: [-1.8, -1.1, -0.4],
        rhrThresholds: [1.9, 1.2, 0.5],
        sampleCount: 84,
      },
      trainingImpulseConstants: {
        genderFactor: 0.64,
        exponent: 1.92,
        sampleCount: 33,
        r2: 0.9124,
      },
    });

    expect(buildPersonalizationModelCards(params)).toEqual([
      expect.objectContaining({
        key: "exponentialMovingAverage",
        status: "personalized",
        lastSuccessfulFitAt: fittedAt,
        lastFitSummary: "Successful fit time recorded",
        dataSufficiency: "120 qualifying days used; minimum 90 days",
        fitEvidence: "Pearson correlation: 0.842",
      }),
      expect.objectContaining({
        key: "readinessWeights",
        status: "personalized",
        lastSuccessfulFitAt: fittedAt,
        lastFitSummary: "Successful fit time recorded",
        dataSufficiency: "91 qualifying days used; minimum 60 days",
        fitEvidence: "Pearson correlation: 0.756",
      }),
      expect.objectContaining({
        key: "sleepTarget",
        status: "personalized",
        lastSuccessfulFitAt: fittedAt,
        lastFitSummary: "Successful fit time recorded",
        dataSufficiency: "22 qualifying nights used; minimum 14 nights",
        fitEvidence: "This average-based fit does not calculate a goodness-of-fit statistic.",
      }),
      expect.objectContaining({
        key: "stressThresholds",
        status: "personalized",
        lastSuccessfulFitAt: fittedAt,
        lastFitSummary: "Successful fit time recorded",
        dataSufficiency: "84 qualifying days used; minimum 60 days",
        fitEvidence: "This percentile-based fit does not calculate a goodness-of-fit statistic.",
      }),
      expect.objectContaining({
        key: "trainingImpulseConstants",
        status: "personalized",
        lastSuccessfulFitAt: fittedAt,
        lastFitSummary: "Successful fit time recorded",
        dataSufficiency: "33 qualifying activities used; minimum 20 activities",
        fitEvidence: "R²: 0.912",
      }),
    ]);
  });

  it("builds all five model cards in stable order", () => {
    const cards = buildPersonalizationModelCards(personalizedParams());

    expect(cards.map((card) => card.key)).toEqual([
      "exponentialMovingAverage",
      "readinessWeights",
      "sleepTarget",
      "stressThresholds",
      "trainingImpulseConstants",
    ]);
  });

  it("reports exact accepted evidence without calling correlation confidence", () => {
    const card = buildPersonalizationModelCards(personalizedParams())[0];

    expect(card).toMatchObject({
      status: "personalized",
      lastSuccessfulFitAt: "2026-07-28T12:00:00.000Z",
      lastFitSummary: "Successful fit time recorded",
      dataWindow: "Past 365 days",
      dataSufficiency: "120 qualifying days used; minimum 90 days",
      fitEvidence: "Pearson correlation: 0.842",
      uncertainty: "No calibrated uncertainty interval is available.",
    });
    expect(card?.fitEvidence).not.toContain("confidence");
  });

  it("marks a legacy learned model timestamp as unavailable until refit", () => {
    const params = personalizedParams({ successfulFitAt: undefined });
    const card = buildPersonalizationModelCards(params)[0];

    expect(card).toMatchObject({
      status: "personalized",
      lastSuccessfulFitAt: null,
      lastFitSummary: "Successful fit time unavailable until this model is refit",
    });
  });

  it("does not guess why a default model has no accepted fit", () => {
    const card = buildPersonalizationModelCards(personalizedParams())[1];

    expect(card).toMatchObject({
      status: "default",
      lastSuccessfulFitAt: null,
      lastFitSummary: "No accepted personalized fit",
      dataSufficiency:
        "No accepted fit; requires at least 60 qualifying days and Pearson correlation of at least 0.15",
      fitEvidence: "No accepted fit statistic is available.",
    });
  });

  it("states when a model does not calculate a goodness-of-fit statistic", () => {
    const params = personalizedParams({
      sleepTarget: { minutes: 480, sampleCount: 22 },
      successfulFitAt: {
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: "2026-07-29T11:00:00.000Z",
        stressThresholds: null,
        trainingImpulseConstants: null,
      },
    });
    const card = buildPersonalizationModelCards(params)[2];

    expect(card).toMatchObject({
      status: "personalized",
      dataSufficiency: "22 qualifying nights used; minimum 14 nights",
      fitEvidence: "This average-based fit does not calculate a goodness-of-fit statistic.",
      uncertainty: "No calibrated uncertainty interval is available.",
    });
  });

  it("describes the exact heart-rate effort source window and exclusions", () => {
    const card = buildPersonalizationModelCards(personalizedParams())[4];

    expect(card?.dataWindow).toBe(
      "All qualifying activities; the power reference uses the past 365 days",
    );
    expect(card?.excludedData).toEqual([
      "Activities without heart-rate samples or normalized power",
      "Activities with non-positive duration or power-based training load",
      "Activities whose maximum heart rate is not above resting heart rate",
    ]);
  });
});
