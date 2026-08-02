/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: { series: Array<{ name: string }> } }) => (
    <div data-testid="power-curve" data-series={JSON.stringify(option.series)} />
  ),
}));

import { PowerCurveChart } from "./PowerCurveChart.tsx";

describe("PowerCurveChart", () => {
  it("leads with a plain-language label for the fitted power model", () => {
    render(
      <PowerCurveChart
        data={[{ durationSeconds: 300, label: "5min", bestPower: 350, activityDate: "2026-07-01" }]}
        model={{ cp: 300, wPrime: 20_000, r2: 0.95 }}
      />,
    );

    expect(screen.getByTestId("power-curve").dataset.series).toContain("Sustainable power model");
    expect(screen.getByText("How this is calculated")).toBeVisible();
    expect(screen.getByText(/Critical Power/)).not.toBeVisible();
  });

  it("hides the method disclosure when the fitted curve has no points", () => {
    render(
      <PowerCurveChart
        data={[{ durationSeconds: 300, label: "5min", bestPower: 350, activityDate: "2026-07-01" }]}
        model={{ cp: 0, wPrime: 20_000, r2: 0.95 }}
      />,
    );

    expect(screen.getByTestId("power-curve").dataset.series).not.toContain(
      "Sustainable power model",
    );
    expect(screen.queryByText("How this is calculated")).toBeNull();
  });
});
