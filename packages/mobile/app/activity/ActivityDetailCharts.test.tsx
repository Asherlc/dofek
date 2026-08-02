import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AreaChart, LineChart } from "./ActivityDetailCharts";

vi.mock("./useChartScrub", () => ({
  useChartScrub: () => ({
    touchIndex: null,
    panResponder: { panHandlers: {} },
  }),
}));

describe("ActivityDetailCharts", () => {
  const data = [{ value: 130 }, { value: null }, { value: 145 }];

  it.each([
    ["line", LineChart],
    ["area", AreaChart],
  ])("provides a VoiceOver summary and exact values for the %s chart", (_, ChartComponent) => {
    render(
      <ChartComponent data={data} color="#ff0000" label="Heart Rate" unit="beats per minute" />,
    );

    expect(
      screen.getByRole("image", {
        name: "Heart Rate. Heart Rate over the activity sample sequence.",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
    expect(screen.getByText("130 beats per minute")).toBeDefined();
    expect(screen.getByText("No value")).toBeDefined();
    expect(screen.getByText("145 beats per minute")).toBeDefined();
  });
});
