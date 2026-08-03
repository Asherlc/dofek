// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { BodyDecisionContext } from "./BodyDecisionContext.tsx";

const context = {
  latestMeasurement: {
    recordedAtLocal: "2026-07-25 08:00:00",
    weightKg: 80,
    providerId: "withings",
    sourceName: "Body+",
  },
  variation: {
    status: "available",
    observations: 12,
    minimumObservations: 8,
    maximumObservations: 30,
    lowerResidualKg: -0.4,
    upperResidualKg: 0.6,
  },
} satisfies ComponentProps<typeof BodyDecisionContext>["context"];

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
