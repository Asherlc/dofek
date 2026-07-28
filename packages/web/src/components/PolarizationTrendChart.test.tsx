/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: () => <div data-testid="polarization-chart" />,
}));

import { PolarizationTrendChart } from "./PolarizationTrendChart.tsx";

describe("PolarizationTrendChart", () => {
  it("renders the server-provided formula, calculation choice, and primary source", () => {
    const method = {
      formula:
        "PI = log10((Z1 / Z2) × Z3 × 100), using each zone's fraction of recorded cycling time.",
      zoneBasis: "Z1 <80%, Z2 80–<90%, and Z3 ≥90% of maximum heart rate.",
      calculationChoice:
        "Dofek requires recorded time in all three zones and does not calculate PI when Z3 exceeds Z1.",
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
});
