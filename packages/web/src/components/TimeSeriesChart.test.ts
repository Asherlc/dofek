/** @vitest-environment jsdom */
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { isSeriesEmpty, TimeSeriesChart } from "./TimeSeriesChart.tsx";

interface TooltipParam {
  seriesName: string;
  value?: [string, number | null];
  data?: [string, number | null];
}

interface ChartElementProps {
  option: {
    aria?: {
      enabled?: boolean;
      label?: {
        description?: string;
      };
    };
    series?: Array<{
      markLine?: {
        data?: Array<{ xAxis: string }>;
        label?: { show?: boolean };
        lineStyle?: { opacity?: number; type?: string };
        silent?: boolean;
        symbol?: string[];
      };
      name?: string;
      smooth?: boolean;
      symbolSize?: number;
      type?: string;
    }>;
    tooltip?: {
      formatter?: (params: TooltipParam[]) => string;
    };
  };
}

describe("isSeriesEmpty", () => {
  it("returns true when all values are null", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
            ["2026-04-03", null],
          ],
        },
      ]),
    ).toBe(true);
  });

  it("returns false when at least one value is non-null", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", 5000],
            ["2026-04-03", null],
          ],
        },
      ]),
    ).toBe(false);
  });

  it("returns true when data array is empty", () => {
    expect(isSeriesEmpty([{ data: [] }])).toBe(true);
  });

  it("returns true when series array is empty", () => {
    expect(isSeriesEmpty([])).toBe(true);
  });

  it("returns false when any series has non-null data in a multi-series chart", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
          ],
        },
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", 34.5],
          ],
        },
      ]),
    ).toBe(false);
  });

  it("returns true when all series have all-null data", () => {
    expect(
      isSeriesEmpty([
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
          ],
        },
        {
          data: [
            ["2026-04-01", null],
            ["2026-04-02", null],
          ],
        },
      ]),
    ).toBe(true);
  });
});

describe("TimeSeriesChart", () => {
  it("renders boolean observations as accessible Yes/No points beside numeric lines", () => {
    const element = TimeSeriesChart({
      accessibilityDescription:
        "Journal trends from April 1, 2026 to April 3, 2026. Missing days are gaps.",
      series: [
        {
          name: "Alcohol",
          data: [
            ["2026-04-01", 1],
            ["2026-04-03", 0],
          ],
          accessibilityDescription: "Alcohol is shown as separate Yes/No points.",
          formatValue: (value) => (value === 1 ? "Yes" : "No"),
          missingDates: ["2026-04-02"],
          visualization: "point",
        },
        {
          name: "Energy",
          data: [
            ["2026-04-01", 8],
            ["2026-04-03", 6],
          ],
          visualization: "line",
        },
      ],
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected TimeSeriesChart to return a chart element");
    }

    expect(element.props.option.series).toMatchObject([
      {
        name: "Alcohol",
        type: "scatter",
        symbolSize: 10,
        markLine: {
          data: [{ xAxis: "2026-04-02" }],
          label: { show: false },
          lineStyle: { opacity: 0.35, type: "dotted" },
          silent: true,
          symbol: ["none", "none"],
        },
      },
      { name: "Energy", type: "line", smooth: true },
    ]);
    expect(element.props.option.aria).toEqual({
      enabled: true,
      label: {
        description:
          "Time series chart. Journal trends from April 1, 2026 to April 3, 2026. Missing days are gaps. Alcohol is shown as separate Yes/No points. Energy is shown as a numeric line.",
      },
    });

    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");
    expect(
      formatter([
        {
          seriesName: "Alcohol",
          value: ["2026-04-01", 1],
        },
      ]),
    ).toContain("Alcohol: <b>Yes</b>");
    expect(
      formatter([
        {
          seriesName: "Alcohol",
          value: ["2026-04-03", 0],
        },
      ]),
    ).toContain("Alcohol: <b>No</b>");
  });

  it("escapes user-controlled tooltip series names and formatted values", () => {
    const element = TimeSeriesChart({
      series: [
        {
          name: 'Mood <script>alert("x")</script>',
          data: [["2026-04-01", 5]],
          formatValue: () => "<img src=x onerror=alert(1)>",
        },
      ],
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected TimeSeriesChart to return a chart element");
    }
    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = formatter([
      {
        seriesName: 'Mood <script>alert("x")</script>',
        value: ["2026-04-01", 5],
      },
    ]);

    expect(html).toContain("Mood &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  it("omits visual missing-day markers when their density would obscure the chart", () => {
    const missingDates = Array.from({ length: 61 }, (_, index) => {
      const date = new Date("2026-01-01T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    });
    const element = TimeSeriesChart({
      series: [
        {
          name: "Energy",
          data: [["2026-01-01", 8]],
          missingDates,
        },
      ],
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected TimeSeriesChart to return a chart element");
    }

    expect(element.props.option.series?.[0]?.markLine).toBeUndefined();
  });
});
