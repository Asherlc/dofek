// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BodyDecisionContext } from "./BodyDecisionContext.tsx";

const context = {
  latestMeasurement: {
    date: "2026-07-25",
    recordedAt: "2026-07-25T15:00:00.000Z",
    recordedAtLocal: "2026-07-25 08:00:00",
    weightKg: 80,
    providerId: "withings",
    sourceName: "Body+",
  },
  trendWeight: {
    smoothing: "ewma" as const,
    alpha: 0.1,
    gapHandling: "linear_interpolation" as const,
    invalidWeightHandling: "exclude_non_positive" as const,
    outlierHandling: "retain" as const,
  },
  variation: {
    status: "available" as const,
    observations: 12,
    minimumObservations: 8,
    maximumObservations: 30,
    method: "tukey_inner_fence" as const,
    lowerResidualKg: -0.4,
    upperResidualKg: 0.6,
    outliersIncluded: true as const,
  },
};

describe("BodyDecisionContext", () => {
  it("renders provenance, method, variation, and source guidance", () => {
    render(<BodyDecisionContext context={context} />);

    expect(screen.getByText(/Latest scale reading: 80\.0 kg/)).toBeTruthy();
    expect(screen.getByText(/Trend Weight moves 10%/)).toBeTruthy();
    expect(screen.getByText(/Personalized typical measurement variation is -0\.4 kg/)).toBeTruthy();
    expect(
      screen.getByText("For comparable readings, use the same scale at a consistent time of day."),
    ).toBeTruthy();
  });

  it("explains when decision context is unavailable", () => {
    render(<BodyDecisionContext context={null} />);

    expect(
      screen.getByText(
        "Measurement decision context is temporarily unavailable. Refresh to try again.",
      ),
    ).toBeTruthy();
  });
});
