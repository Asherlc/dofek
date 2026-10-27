/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let capturedOption: Record<string, unknown> | null = null;

vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    style,
  }: {
    option: Record<string, unknown>;
    style: Record<string, unknown>;
  }) => {
    capturedOption = option;
    return (
      <div
        data-testid="echarts-mock"
        data-option={JSON.stringify(option)}
        style={style satisfies React.CSSProperties}
      />
    );
  },
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
            activityType: "cycling",
            modality: "gravel",
            verticalAscentRate: 700,
            elevationGainMeters: 350,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-01",
            activityName: "Road Ride",
            activityType: "cycling",
            modality: "road",
            verticalAscentRate: 600,
            elevationGainMeters: 300,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-02",
            activityName: "Trail Ride",
            activityType: "cycling",
            modality: "mountain",
            verticalAscentRate: 500,
            elevationGainMeters: 250,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-04",
            activityName: "Trainer Ride",
            activityType: "cycling",
            modality: "indoor",
            verticalAscentRate: 400,
            elevationGainMeters: 200,
            elapsedMinutes: 30,
          },
          {
            date: "2026-04-05",
            activityName: "Virtual Ride",
            activityType: "cycling",
            modality: "virtual",
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

  it("escapes provider-controlled activity names and types in HTML tooltips", () => {
    const maliciousName = '<img src=x onerror="alert(1)"> & "ride"';
    const maliciousType = "road_cycling<script>alert('x')</script>";
    render(
      <VerticalAscentChart
        data={[
          {
            date: "2026-04-03",
            activityName: maliciousName,
            activityType: maliciousType,
            modality: null,
            verticalAscentRate: 700,
            elevationGainMeters: 350,
            elapsedMinutes: 30,
          },
        ]}
      />,
    );

    const tooltip = capturedOption?.tooltip;
    if (
      !tooltip ||
      typeof tooltip !== "object" ||
      !("formatter" in tooltip) ||
      typeof tooltip.formatter !== "function"
    ) {
      throw new Error("Expected tooltip formatter");
    }
    const series = capturedOption?.series;
    if (!Array.isArray(series) || !series[0] || !("data" in series[0])) {
      throw new Error("Expected chart series data");
    }
    const seriesData = series[0].data;
    if (!Array.isArray(seriesData) || !seriesData[0]) {
      throw new Error("Expected first chart data point");
    }

    const html = String(tooltip.formatter({ data: seriesData[0] }));

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;ride&quot;");
    expect(html).toContain("Road Cycling&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain("<script>");
  });
});
