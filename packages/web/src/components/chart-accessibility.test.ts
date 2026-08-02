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

  it("deduplicates series names and trims metadata before formatting the list", () => {
    expect(
      buildChartSummary({
        series: [
          { name: " Recovery ", data: [1] },
          { name: "Recovery", data: [2] },
          { name: "Sleep", data: [3] },
          { name: "Readiness", data: [4] },
        ],
      }),
    ).toBe(
      "Chart showing Recovery, Sleep, and Readiness. Use the chart data table for exact values.",
    );

    expect(buildChartSummary({ series: [{ name: " Recovery " }] })).toBe("Chart showing Recovery.");
  });

  it("falls back from axis names to chart type and then to a generic chart summary", () => {
    expect(
      buildChartSummary({
        xAxis: [{ name: " Date " }, { name: "Date" }],
        yAxis: { name: "Recovery" },
        series: [{ type: "line" }],
      }),
    ).toBe("Chart comparing Date and Recovery.");
    expect(buildChartSummary({ series: [{ type: "heatmap" }] })).toBe("Heat map chart.");
    expect(buildChartSummary({ series: [{ type: " line " }] })).toBe("Line chart.");
    expect(buildChartSummary({})).toBe("Chart.");
    expect(buildChartSummary({ xAxis: { name: "Date" } })).toBe("Chart comparing Date.");
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

  it("enables ARIA without discarding non-record options or existing labels", () => {
    expect(
      addChartAria(
        {
          title: "Recovery",
          aria: { enabled: false, label: { role: "img" } },
        },
        "Chart description",
      ),
    ).toEqual({
      title: "Recovery",
      aria: { enabled: true, label: { role: "img", description: "Chart description" } },
    });
    expect(addChartAria({ aria: "invalid" }, "Chart description")).toEqual({
      aria: { enabled: true, label: { description: "Chart description" } },
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

  it("requires at least one populated series for a data-table hint", () => {
    expect(
      hasChartTableData({
        series: [
          { name: "Empty", data: [] },
          { name: "Recovery", data: [72] },
        ],
      }),
    ).toBe(true);
    expect(hasChartTableData({ series: { name: "Recovery", data: [72] } })).toBe(true);
    expect(hasChartTableData({ series: [{ name: "Empty", data: [] }] })).toBe(false);
    expect(hasChartTableData({ series: [{ name: "Missing" }, "invalid"] })).toBe(false);
    expect(hasChartTableData({ series: "invalid" })).toBe(false);
  });

  it("uses category-axis defaults and preserves series order in table rows", () => {
    expect(
      buildChartTable({
        xAxis: [
          { type: "value", name: "Ignored" },
          { type: "category", data: ["A", "B"] },
        ],
        yAxis: [{ name: "Value" }, "invalid"],
        series: [
          { data: [{ name: "Named", value: 1 }, { value: null }] },
          { data: [["B", 2, 3], ["A"]] },
          { data: "invalid" },
          "invalid",
        ],
      }),
    ).toEqual({
      categoryHeader: "Category",
      rows: [
        { series: "Series 1", category: "Named", value: "1" },
        { series: "Series 1", category: "B", value: "No value" },
        { series: "Series 2", category: "B", value: "2, 3" },
        { series: "Series 2", category: "B", value: "A" },
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

  it("supports object-form series, axis arrays, and tuple/value formatting fallbacks", () => {
    expect(
      buildChartTable({
        xAxis: [{ name: "Date" }, { name: "" }],
        series: {
          name: "Recovery",
          data: [
            ["2026-07-01", 52],
            ["2026-07-02", 53, { value: 54 }],
            { value: ["2026-07-03", 55] },
            { value: ["2026-07-04"] },
            { value: { name: "Unavailable label" } },
            { value: { other: true } },
            null,
            undefined,
            true,
          ],
        },
      }),
    ).toEqual({
      categoryHeader: "Date",
      rows: [
        { series: "Recovery", category: "2026-07-01", value: "52" },
        { series: "Recovery", category: "2026-07-02", value: "53, 54" },
        { series: "Recovery", category: "2026-07-03", value: "55" },
        { series: "Recovery", category: "4", value: "2026-07-04" },
        { series: "Recovery", category: "5", value: "Unavailable label" },
        { series: "Recovery", category: "6", value: "Value unavailable" },
        { series: "Recovery", category: "7", value: "No value" },
        { series: "Recovery", category: "8", value: "No value" },
        { series: "Recovery", category: "9", value: "true" },
      ],
    });
  });

  it("formats primitive, array, and object cells consistently", () => {
    expect(
      buildChartTable({
        xAxis: { data: [null, undefined, false, ["nested", 2]] },
        series: [
          { name: "Values", data: [null, undefined, false, ["a", 2], { value: [1, null] }] },
        ],
      }),
    ).toEqual({
      categoryHeader: "Category",
      rows: [
        { series: "Values", category: "1", value: "No value" },
        { series: "Values", category: "2", value: "No value" },
        { series: "Values", category: "false", value: "false" },
        { series: "Values", category: "a", value: "2" },
        { series: "Values", category: "1", value: "No value" },
      ],
    });
  });
});
