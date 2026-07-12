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
    activityType: "mountain_biking",
    verticalAscentRate: 800,
    elevationGainMeters: 600,
    climbingMinutes: 45,
  },
  {
    date: "2024-06-08",
    activityName: "Hill Repeats",
    activityType: "road_cycling",
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

  it("uses stable colors for each cycling type", () => {
    const { container } = render(
      <VerticalAscentChart
        data={[
          {
            date: "2024-06-08",
            activityName: "Hill Repeats",
            activityType: "road_cycling",
            verticalAscentRate: 1200,
            elevationGainMeters: 400,
            climbingMinutes: 20,
          },
          {
            date: "2024-06-01",
            activityName: "Mountain Ride",
            activityType: "mountain_biking",
            verticalAscentRate: 800,
            elevationGainMeters: 600,
            climbingMinutes: 45,
          },
        ]}
        units={METRIC}
        width={360}
      />,
    );
    const circles = [...container.querySelectorAll("circle")];
    expect(circles.map((circle) => circle.getAttribute("fill"))).toEqual(["#0ea5e9", "#5E35B1"]);
  });

  it("renders x-axis date labels", () => {
    render(<VerticalAscentChart data={SAMPLE_DATA} units={METRIC} width={360} />);
    expect(screen.getByText("Jun 1")).toBeTruthy();
    expect(screen.getByText("Jun 8")).toBeTruthy();
  });

  it("renders x-axis labels for ISO timestamp dates", () => {
    render(
      <VerticalAscentChart
        data={[
          {
            ...SAMPLE_DATA[0],
            date: "2024-06-01T10:00:00.000Z",
          },
          {
            ...SAMPLE_DATA[1],
            date: "2024-06-08T10:00:00.000Z",
          },
        ]}
        units={METRIC}
        width={360}
      />,
    );
    expect(screen.getByText("Jun 1")).toBeTruthy();
    expect(screen.getByText("Jun 8")).toBeTruthy();
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
