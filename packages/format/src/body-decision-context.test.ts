import { describe, expect, it } from "vitest";
import {
  BODY_SOURCE_GUIDANCE,
  BODY_TREND_WEIGHT_DECISION_COPY,
  formatBodyDecisionProvenance,
  formatBodyDecisionVariation,
  formatSignedBodyResidual,
} from "./body-decision-context.ts";

const formatWeight = (value: number) => `${value.toFixed(1)} kg`;

describe("body decision context formatting", () => {
  it("returns no provenance when there is no latest measurement", () => {
    expect(
      formatBodyDecisionProvenance(null, {
        formatWeight,
        providerLabel: (providerId) => providerId,
      }),
    ).toBeNull();
  });

  it("uses the same provenance copy for the measurement source and local time", () => {
    expect(
      formatBodyDecisionProvenance(
        {
          recordedAtLocal: "2026-07-25 08:00:00",
          weightKg: 80,
          providerId: "withings",
          sourceName: "Body+",
        },
        {
          formatWeight,
          providerLabel: (providerId) => (providerId === "withings" ? "Withings" : providerId),
        },
      ),
    ).toBe(
      "Latest scale reading: 80.0 kg · Provider: Withings · Source: Body+ · Recorded: 2026-07-25 08:00:00",
    );
  });

  it("omits provenance copy when the source name is absent", () => {
    expect(
      formatBodyDecisionProvenance(
        {
          recordedAtLocal: "2026-07-25 08:00:00",
          weightKg: 80,
          providerId: "withings",
          sourceName: null,
        },
        {
          formatWeight,
          providerLabel: () => "Withings",
        },
      ),
    ).toBe("Latest scale reading: 80.0 kg · Provider: Withings · Recorded: 2026-07-25 08:00:00");
  });

  it("formats positive, negative, and zero residuals with absolute magnitudes", () => {
    expect(formatSignedBodyResidual(0.4, formatWeight)).toBe("+0.4 kg");
    expect(formatSignedBodyResidual(-0.4, formatWeight)).toBe("-0.4 kg");
    expect(formatSignedBodyResidual(0, formatWeight)).toBe("0.0 kg");
  });

  it("describes available variation as an informational residual band", () => {
    expect(
      formatBodyDecisionVariation(
        {
          status: "available",
          observations: 12,
          minimumObservations: 8,
          maximumObservations: 30,
          lowerResidualKg: -0.4,
          upperResidualKg: 0.6,
        },
        (value) => formatSignedBodyResidual(value, formatWeight),
      ),
    ).toBe(
      "Personalized typical measurement variation is -0.4 kg to +0.6 kg around Trend Weight, based on 12 of the latest 30 actual scale readings. This is informational, not a clinical threshold; outliers remain included.",
    );
  });

  it("states when variation needs more readings", () => {
    expect(
      formatBodyDecisionVariation(
        {
          status: "insufficient_data",
          observations: 7,
          minimumObservations: 8,
          maximumObservations: 30,
          lowerResidualKg: null,
          upperResidualKg: null,
        },
        (value) => formatSignedBodyResidual(value, formatWeight),
      ),
    ).toBe(
      "Personalized typical measurement variation is unavailable until at least 8 actual scale readings are available.",
    );
  });

  it("treats either missing residual bound as unavailable", () => {
    const formatResidual = (value: number) => formatSignedBodyResidual(value, formatWeight);
    const baseVariation = {
      status: "available" as const,
      observations: 12,
      minimumObservations: 8,
      maximumObservations: 30,
    };

    expect(
      formatBodyDecisionVariation(
        { ...baseVariation, lowerResidualKg: null, upperResidualKg: 0.6 },
        formatResidual,
      ),
    ).toContain("unavailable until at least 8 actual scale readings are available");
    expect(
      formatBodyDecisionVariation(
        { ...baseVariation, lowerResidualKg: -0.4, upperResidualKg: null },
        formatResidual,
      ),
    ).toContain("unavailable until at least 8 actual scale readings are available");
  });

  it("treats a non-available status as unavailable even when bounds are present", () => {
    expect(
      formatBodyDecisionVariation(
        {
          status: "insufficient_data",
          observations: 8,
          minimumObservations: 8,
          maximumObservations: 30,
          lowerResidualKg: -0.4,
          upperResidualKg: 0.6,
        },
        (value) => formatSignedBodyResidual(value, formatWeight),
      ),
    ).toBe(
      "Personalized typical measurement variation is unavailable until at least 8 actual scale readings are available.",
    );
  });

  it("keeps the Trend Weight method and source guidance as shared copy", () => {
    expect(BODY_TREND_WEIGHT_DECISION_COPY).toContain("Missing days are linearly interpolated");
    expect(BODY_SOURCE_GUIDANCE).toBe(
      "For comparable readings, use the same scale at a consistent time of day.",
    );
  });
});
