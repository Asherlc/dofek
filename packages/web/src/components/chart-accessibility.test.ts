import { describe, expect, it } from "vitest";
import {
  addChartAria,
  buildChartSummary,
  buildChartTable,
  hasChartTableData,
} from "./chart-accessibility.ts";

describe("chart accessibility helpers", () => {
  it("derives a concise summary from chart series metadata", () => {
    expect(
      buildChartSummary({
        xAxis: { data: ["Monday", "Tuesday"] },
        series: [
          { type: "line", name: "Recovery", data: [72, 81] },
          { type: "line", name: "Sleep", data: [7, 8] },
        ],
      }),
    ).toBe("Chart showing Recovery and Sleep. Use the chart data table for exact values.");
  });

  it("preserves an explicit description while enabling chart ARIA", () => {
    const input = {
      aria: {
        label: { description: "The server-authored recovery explanation." },
        decal: { show: true },
      },
    };
    const option = addChartAria(input, buildChartSummary(input));

    expect(option.aria).toEqual({
      enabled: true,
      label: { description: "The server-authored recovery explanation." },
      decal: { show: true },
    });
  });

  it("maps category and series data to exact accessible table rows", () => {
    const option = {
      xAxis: { type: "category", name: "Day", data: ["Monday", "Tuesday"] },
      series: [
        { type: "bar", name: "Steps", data: [4_200, 6_100] },
        {
          type: "line",
          name: "Distance",
          data: [
            ["Monday", 3.2],
            ["Tuesday", 4.1],
          ],
        },
      ],
    };

    expect(hasChartTableData(option)).toBe(true);
    expect(buildChartTable(option)).toEqual({
      categoryHeader: "Day",
      rows: [
        { series: "Steps", category: "Monday", value: "4200" },
        { series: "Steps", category: "Tuesday", value: "6100" },
        { series: "Distance", category: "Monday", value: "3.2" },
        { series: "Distance", category: "Tuesday", value: "4.1" },
      ],
    });
  });

  it("uses a named time axis for tuple data without category values", () => {
    expect(
      buildChartTable({
        xAxis: { type: "time", name: "Date" },
        series: [{ type: "line", name: "Recovery", data: [["2026-07-01", 52]] }],
      }),
    ).toEqual({
      categoryHeader: "Date",
      rows: [{ series: "Recovery", category: "2026-07-01", value: "52" }],
    });
  });
});
