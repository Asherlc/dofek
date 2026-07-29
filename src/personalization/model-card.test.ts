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
