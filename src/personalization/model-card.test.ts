import { describe, expect, it } from "vitest";
import { buildPersonalizationModelCards } from "./model-card.ts";
import type { PersonalizedParams } from "./params.ts";

function personalizedParams(overrides: Partial<PersonalizedParams> = {}): PersonalizedParams {
  return {
    version: 2,
    fittedAt: "2026-07-29T12:00:00.000Z",
    successfulFitAt: {
      exponentialMovingAverage: "2026-07-28T12:00:00.000Z",
      stressThresholds: null,
    },
    exponentialMovingAverage: {
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
      sampleCount: 120,
      correlation: 0.842,
    },
    stressThresholds: null,
    ...overrides,
  };
}

describe("buildPersonalizationModelCards", () => {
  it("describes the complete default evidence contract when no fits exist", () => {
    const cards = buildPersonalizationModelCards(null);
    expect(cards).toEqual([
      expect.objectContaining({
        key: "exponentialMovingAverage",
        status: "default",
        lastSuccessfulFitAt: null,
      }),
      expect.objectContaining({
        key: "stressThresholds",
        status: "default",
        lastSuccessfulFitAt: null,
      }),
    ]);
  });

  it("describes personalized evidence for every fitted model", () => {
    const fittedAt = "2026-07-28T12:00:00.000Z";
    const params = personalizedParams({
      successfulFitAt: {
        exponentialMovingAverage: fittedAt,
        stressThresholds: fittedAt,
      },
      stressThresholds: {
        hrvThresholds: [-1.8, -1.1, -0.4],
        rhrThresholds: [1.9, 1.2, 0.5],
        sampleCount: 84,
      },
    });
    expect(buildPersonalizationModelCards(params)).toEqual([
      expect.objectContaining({
        key: "exponentialMovingAverage",
        status: "personalized",
        lastSuccessfulFitAt: fittedAt,
      }),
      expect.objectContaining({
        key: "stressThresholds",
        status: "personalized",
        lastSuccessfulFitAt: fittedAt,
      }),
    ]);
  });

  it("builds model cards in stable order", () => {
    const cards = buildPersonalizationModelCards(personalizedParams());
    expect(cards.map((card) => card.key)).toEqual(["exponentialMovingAverage", "stressThresholds"]);
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
      dataSufficiency: "No accepted fit; requires at least 60 qualifying days",
      fitEvidence: "No accepted fit statistic is available.",
    });
  });

  it("states when a model does not calculate a goodness-of-fit statistic", () => {
    const params = personalizedParams({
      successfulFitAt: {
        exponentialMovingAverage: null,
        stressThresholds: null,
      },
      stressThresholds: {
        hrvThresholds: [-1.5, -1, -0.5],
        rhrThresholds: [1.5, 1, 0.5],
        sampleCount: 84,
      },
    });
    const card = buildPersonalizationModelCards(params)[1];

    expect(card).toMatchObject({
      status: "personalized",
      dataSufficiency: "84 qualifying days used; minimum 60 days",
      fitEvidence: "This percentile-based fit does not calculate a goodness-of-fit statistic.",
      uncertainty: "No calibrated uncertainty interval is available.",
    });
  });
});
