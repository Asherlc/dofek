import { formatDateTime } from "@dofek/format/format";
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
  const data = [
    { recordedAt: "2026-10-04T16:52:51.440Z", value: 130 },
    { recordedAt: "2026-10-04T16:53:51.440Z", value: null },
    { recordedAt: "2026-10-04T16:54:51.440Z", value: 145 },
  ];

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
    expect(screen.getByText(`Sample 1 · ${formatDateTime(data[0].recordedAt)}`)).toBeDefined();
    expect(screen.getByText("130 beats per minute")).toBeDefined();
    expect(screen.getByText("No value")).toBeDefined();
    expect(screen.getByText("145 beats per minute")).toBeDefined();
  });

  it("identifies separate samples with the same timestamp and value", () => {
    const sample = { recordedAt: "2026-10-04T16:52:51.440Z", value: 130 };
    render(
      <LineChart
        data={[sample, sample]}
        color="#ff0000"
        label="Heart Rate"
        unit="beats per minute"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
    const timestamp = formatDateTime(sample.recordedAt);
    expect(screen.getByLabelText(`Sample 1 · ${timestamp}: 130 beats per minute`)).toBeDefined();
    expect(screen.getByLabelText(`Sample 2 · ${timestamp}: 130 beats per minute`)).toBeDefined();
  });
});
