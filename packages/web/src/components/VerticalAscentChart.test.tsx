/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    style,
  }: {
    option: Record<string, unknown>;
    style: Record<string, unknown>;
  }) => (
    <div
      data-testid="echarts-mock"
      data-option={JSON.stringify(option)}
      style={style satisfies React.CSSProperties}
    />
  ),
}));

vi.mock("./LoadingSkeleton.tsx", () => ({
  ChartLoadingSkeleton: ({ height }: { height: number }) => (
    <div data-testid="loading-skeleton" style={{ height }} />
  ),
}));

const { VerticalAscentChart } = await import("./VerticalAscentChart.tsx");

describe("VerticalAscentChart", () => {
  it("renders separate scatter series by cycling type with stable colors", () => {
    render(
      <VerticalAscentChart
        data={[
          {
            date: "2026-04-03",
            activityName: "Gravel Ride",
            activityType: "gravel_cycling",
            verticalAscentRate: 700,
            elevationGainMeters: 350,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-01",
            activityName: "Road Ride",
            activityType: "road_cycling",
            verticalAscentRate: 600,
            elevationGainMeters: 300,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-02",
            activityName: "Trail Ride",
            activityType: "mountain_biking",
            verticalAscentRate: 500,
            elevationGainMeters: 250,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-04",
            activityName: "Trainer Ride",
            activityType: "indoor_cycling",
            verticalAscentRate: 400,
            elevationGainMeters: 200,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-05",
            activityName: "Virtual Ride",
            activityType: "virtual_cycling",
            verticalAscentRate: 300,
            elevationGainMeters: 150,
            elapsedMinutes: 30,
          },
        ]}
      />,
    );

    const chartElement = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chartElement.dataset.option ?? "{}");

    expect(option.legend.show).toBe(true);
    expect(option.series.map((series: { name: string }) => series.name)).toEqual([
      "Gravel Cycling",
      "Road Cycling",
      "Mountain Biking",
      "Other Cycling",
    ]);
    expect(
      option.series.map((series: { itemStyle: { color: string } }) => series.itemStyle.color),
    ).toEqual(["#ea580c", "#0ea5e9", "#5E35B1", "#2563eb"]);
    const otherSeries = option.series.find(
      (series: { name: string }) => series.name === "Other Cycling",
    );
    expect(otherSeries.data).toHaveLength(2);
    expect(option.series.every((series: { type: string }) => series.type === "scatter")).toBe(true);
    expect(option.xAxis.name).toBe("Date");
  });
});
