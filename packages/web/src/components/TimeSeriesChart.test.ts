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
});
