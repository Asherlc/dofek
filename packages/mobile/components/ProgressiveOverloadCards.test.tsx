// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressiveOverloadCards } from "./ProgressiveOverloadCards";

const evidence = {
  exerciseName: "Back Squat",
  observations: [
    { week: "2026-01-05", totalVolumeKg: 4_800 },
    { week: "2026-01-19", totalVolumeKg: 5_100 },
    { week: "2026-02-02", totalVolumeKg: 5_450 },
    { week: "2026-02-09", totalVolumeKg: 5_250 },
  ],
  period: {
    startWeek: "2026-01-05",
    endWeek: "2026-02-09",
    observationCount: 4,
    elapsedWeekCount: 6,
  },
  slopeKgPerWeek: 100,
  trend: "increasing" as const,
  uncertainty: {
    availability: "available" as const,
    level: 0.95 as const,
    method: "residual_circular_moving_block_bootstrap" as const,
    methodLabel: "95% moving-block interval",
    lowerKgPerWeek: -25,
    upperKgPerWeek: 240,
    statement: "The interval reflects variation and short-range dependence among recorded weeks.",
  },
  interpretation:
    "Recorded weekly volume increased over this period. An increase is not inherently good or bad.",
  deloadContext:
    "Recorded volume cannot distinguish a planned deload from missed training or incomplete data.",
};

describe("ProgressiveOverloadCards", () => {
  it("renders complete server-authored evidence in one accessible exercise summary", () => {
    render(
      <ProgressiveOverloadCards
        exercises={[evidence]}
        loading={false}
        units={new UnitConverter("metric")}
      />,
    );

    expect(screen.getByText("Exercise Volume Trends")).toBeTruthy();
    expect(screen.getByText("Back Squat")).toBeTruthy();
    expect(screen.getByText("Increasing 100.0 kg/week")).toBeTruthy();
    expect(screen.getByText("Jan 5, 2026 – Feb 9, 2026")).toBeTruthy();
    expect(screen.getByText("4 recorded weeks across 6 calendar weeks")).toBeTruthy();
    expect(screen.getByText("95% moving-block interval: -25.0 to 240.0 kg/week")).toBeTruthy();
    expect(screen.getByText(evidence.uncertainty.statement)).toBeTruthy();
    expect(screen.getByText(evidence.interpretation)).toBeTruthy();
    expect(screen.getByText(evidence.deloadContext)).toBeTruthy();
    expect(
      screen.getByLabelText(
        "Back Squat. Increasing 100.0 kg/week. Jan 5, 2026 to Feb 9, 2026. 4 recorded weeks across 6 calendar weeks. 95% moving-block interval: -25.0 to 240.0 kg/week. The interval reflects variation and short-range dependence among recorded weeks. Recorded weekly volume increased over this period. An increase is not inherently good or bad. Recorded volume cannot distinguish a planned deload from missed training or incomplete data.",
      ),
    ).toBeTruthy();
  });

  it("renders unavailable uncertainty exactly and formats imperial rates", () => {
    render(
      <ProgressiveOverloadCards
        exercises={[
          {
            ...evidence,
            slopeKgPerWeek: -1,
            trend: "decreasing",
            uncertainty: {
              availability: "unavailable",
              level: 0.95,
              method: "residual_circular_moving_block_bootstrap",
              methodLabel: "95% moving-block interval",
              reason: "insufficient_observations",
              statement: "Uncertainty needs at least 4 recorded weeks; this estimate has 3.",
            },
          },
        ]}
        loading={false}
        units={new UnitConverter("imperial")}
      />,
    );

    expect(screen.getByText("Decreasing 2.2 lb/week")).toBeTruthy();
    expect(
      screen.getByText("Uncertainty needs at least 4 recorded weeks; this estimate has 3."),
    ).toBeTruthy();
  });

  it("distinguishes loading and empty states", () => {
    const { rerender } = render(
      <ProgressiveOverloadCards exercises={[]} loading units={new UnitConverter("metric")} />,
    );

    expect(screen.getByText("Loading exercise volume trends")).toBeTruthy();

    rerender(
      <ProgressiveOverloadCards
        exercises={[]}
        loading={false}
        units={new UnitConverter("metric")}
      />,
    );

    expect(screen.getByText("No exercise volume trends in this period")).toBeTruthy();
  });
});
