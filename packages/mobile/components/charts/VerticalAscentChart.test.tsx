import { UnitConverter } from "@dofek/format/units";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerticalAscentChart, type VerticalAscentDataPoint } from "./VerticalAscentChart";

const METRIC = new UnitConverter("metric");
const IMPERIAL = new UnitConverter("imperial");

const SAMPLE_DATA: VerticalAscentDataPoint[] = [
  {
    date: "2024-06-01",
    activityName: "Mountain Ride",
    verticalAscentRate: 800,
    elevationGainMeters: 600,
    climbingMinutes: 45,
  },
  {
    date: "2024-06-08",
    activityName: "Hill Repeats",
    verticalAscentRate: 1200,
    elevationGainMeters: 400,
    climbingMinutes: 20,
  },
];

describe("VerticalAscentChart", () => {
  it("renders empty state when no data", () => {
    render(<VerticalAscentChart data={[]} units={METRIC} />);
    expect(screen.getByText("No activities with altitude data available")).toBeTruthy();
  });

  it("renders SVG bubbles for each data point", () => {
    const { container } = render(
      <VerticalAscentChart data={SAMPLE_DATA} units={METRIC} width={360} />,
    );
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(SAMPLE_DATA.length);
  });

  it("shows metric axis label", () => {
    render(<VerticalAscentChart data={SAMPLE_DATA} units={METRIC} width={360} />);
    expect(screen.getByText("Vertical Ascent Rate (m/h)")).toBeTruthy();
  });

  it("shows imperial axis label", () => {
    render(<VerticalAscentChart data={SAMPLE_DATA} units={IMPERIAL} width={360} />);
    expect(screen.getByText("Vertical Ascent Rate (ft/h)")).toBeTruthy();
  });

  it("renders caption text", () => {
    render(<VerticalAscentChart data={SAMPLE_DATA} units={METRIC} width={360} />);
    expect(
      screen.getByText("Bubble size indicates elevation gain. Higher = stronger climbing."),
    ).toBeTruthy();
  });
});
