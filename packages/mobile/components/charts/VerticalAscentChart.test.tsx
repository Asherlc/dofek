import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
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
    elapsedMinutes: 45,
  },
  {
    date: "2024-06-08",
    activityName: "Hill Repeats",
    activityType: "road_cycling",
    verticalAscentRate: 1200,
    elevationGainMeters: 400,
    elapsedMinutes: 20,
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

  it("provides a VoiceOver summary and exact activity values", () => {
    render(<VerticalAscentChart data={SAMPLE_DATA} units={METRIC} width={360} />);

    expect(
      screen.getByRole("image", {
        name: "Vertical ascent rate. Vertical ascent rate by activity; bubble size represents elevation gain.",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View Vertical ascent rate data" }));
    expect(screen.getByText("Mountain Ride")).toBeDefined();
    expect(screen.getByText(/800 meters per hour/)).toBeDefined();
    expect(screen.getByText("Hill Repeats")).toBeDefined();
    expect(screen.getByText(/1200 meters per hour/)).toBeDefined();
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
            elapsedMinutes: 20,
          },
          {
            date: "2024-06-01",
            activityName: "Mountain Ride",
            activityType: "mountain_biking",
            verticalAscentRate: 800,
            elevationGainMeters: 600,
            elapsedMinutes: 45,
          },
        ]}
        units={METRIC}
        width={360}
      />,
    );
    const circles = [...container.querySelectorAll("circle")];
    expect(circles.map((circle) => circle.getAttribute("fill"))).toEqual(["#0ea5e9", "#5E35B1"]);
  });

  it("groups indoor and virtual cycling types as other cycling with gravel separate", () => {
    const { container } = render(
      <VerticalAscentChart
        data={[
          {
            date: "2024-06-01",
            activityName: "Trainer Ride",
            activityType: "indoor_cycling",
            verticalAscentRate: 800,
            elevationGainMeters: 600,
            elapsedMinutes: 45,
          },
          {
            date: "2024-06-08",
            activityName: "Virtual Ride",
            activityType: "virtual_cycling",
            verticalAscentRate: 1200,
            elevationGainMeters: 400,
            elapsedMinutes: 20,
          },
          {
            date: "2024-06-15",
            activityName: "Gravel Ride",
            activityType: "gravel_cycling",
            verticalAscentRate: 1000,
            elevationGainMeters: 500,
            elapsedMinutes: 30,
          },
        ]}
        units={METRIC}
        width={360}
      />,
    );
    expect(screen.getByText("Other Cycling")).toBeTruthy();
    expect(screen.getByText("Gravel Cycling")).toBeTruthy();
    expect(screen.queryByText("Indoor Cycling")).toBeNull();
    expect(screen.queryByText("Virtual Cycling")).toBeNull();

    const circles = [...container.querySelectorAll("circle")];
    expect(circles.map((circle) => circle.getAttribute("fill"))).toEqual([
      "#2563eb",
      "#2563eb",
      "#ea580c",
    ]);
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

  it("renders one x-axis label when all activities are on the same date", () => {
    render(
      <VerticalAscentChart
        data={[
          {
            ...SAMPLE_DATA[0],
            activityName: "Morning Ride",
            date: "2024-06-01",
          },
          {
            ...SAMPLE_DATA[1],
            activityName: "Evening Ride",
            date: "2024-06-01",
          },
        ]}
        units={METRIC}
        width={360}
      />,
    );
    expect(screen.getAllByText("Jun 1")).toHaveLength(1);
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
