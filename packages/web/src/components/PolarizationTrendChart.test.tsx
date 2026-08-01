/** @vitest-environment jsdom */

import { DEFAULT_POLARIZATION_THRESHOLD } from "@dofek/training/training-distribution";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: { yAxis?: { max?: number } } }) => (
    <div data-testid="polarization-chart" data-y-max={option.yAxis?.max} />
  ),
}));

import { PolarizationTrendChart } from "./PolarizationTrendChart.tsx";

describe("PolarizationTrendChart", () => {
  it("renders the server-provided formula, calculation choice, and primary source", () => {
    const method = {
      formula:
        "Polarization index = log10((easy-zone fraction / threshold-zone fraction) × high-zone fraction × 100).",
      zoneBasis:
        "Easy zone (Zone 1) is below 80%, threshold zone (Zone 2) is 80–<90%, and high zone (Zone 3) is at least 90% of maximum heart rate.",
      calculationChoice:
        "Dofek requires recorded time in all three zones and does not calculate the polarization index when high-zone time exceeds easy-zone time.",
      interpretation:
        "The >2.00 comparison is Treff's descriptive training-distribution heuristic, not a physiological or medical assessment.",
      source: {
        title: "Treff et al. (2019), The Polarization-Index",
        url: "https://doi.org/10.3389/fphys.2019.00707",
      },
    };

    render(<PolarizationTrendChart weeks={[]} maxHr={190} method={method} />);

    expect(screen.getByText(method.formula)).toBeTruthy();
    expect(screen.getByText(method.zoneBasis)).toBeTruthy();
    expect(screen.getByText(method.calculationChoice)).toBeTruthy();
    expect(screen.getByText(method.interpretation)).toBeTruthy();
    expect(screen.getByRole("link", { name: method.source.title })).toHaveAttribute(
      "href",
      method.source.url,
    );
  });

  it("uses the shared threshold when the server omits one", () => {
    render(
      <PolarizationTrendChart
        weeks={[
          {
            week: "2026-07-06",
            z1Seconds: 3600,
            z2Seconds: 600,
            z3Seconds: 1200,
            totalSeconds: 5400,
            zonePercentages: { z1: 66.7, z2: 11.1, z3: 22.2 },
            polarizationIndex: 1.5,
            status: "not_polarized",
            statusLabel: "Does not match polarized-pattern heuristic",
            explanation: "Server-authored explanation.",
          },
        ]}
        maxHr={190}
        threshold={undefined}
        method={null}
      />,
    );

    expect(screen.getByTestId("polarization-chart")).toHaveAttribute(
      "data-y-max",
      String(DEFAULT_POLARIZATION_THRESHOLD),
    );
  });
});
