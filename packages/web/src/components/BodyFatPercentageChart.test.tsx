/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BodyRecompositionRow } from "../../../server/src/routers/body-analytics.ts";
import { UnitContext } from "../lib/unitContext.ts";

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
        data-option={JSON.stringify(option, (_key, value) =>
          typeof value === "function" ? "[function]" : value,
        )}
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

const { BodyFatPercentageChart } = await import("./BodyFatPercentageChart.tsx");

type TooltipFormatter = (
  params: Array<{
    seriesName: string;
    marker?: string;
    value?: [string, number];
    data?: unknown;
  }>,
) => string;

interface NamedSeries {
  name: string;
  type: string;
  data: unknown[];
}

function isNamedSeries(value: unknown): value is NamedSeries {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "type" in value &&
    typeof value.type === "string" &&
    "data" in value &&
    Array.isArray(value.data)
  );
}

const sampleData: BodyRecompositionRow[] = [
  {
    date: "2026-02-28",
    weightKg: 86,
    bodyFatPct: 21.2,
    fatMassKg: 18.23,
    leanMassKg: 67.77,
    smoothedFatMass: 18.23,
    smoothedLeanMass: 67.77,
  },
  {
    date: "2026-03-01",
    weightKg: 85.5,
    bodyFatPct: 20.9,
    fatMassKg: 17.87,
    leanMassKg: 67.63,
    smoothedFatMass: 17.87,
    smoothedLeanMass: 67.63,
  },
];

function renderWithUnits(children: ReactNode) {
  return render(
    <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
      {children}
    </UnitContext.Provider>,
  );
}

function getSeries(): NamedSeries {
  const series = capturedOption?.series;
  if (!Array.isArray(series) || series.length !== 1) {
    throw new Error("Expected one chart series");
  }
  const [chartSeries] = series;
  if (!isNamedSeries(chartSeries)) {
    throw new Error("Expected a named line series");
  }
  return chartSeries;
}

function getTooltipFormatter(): TooltipFormatter {
  const tooltip = capturedOption?.tooltip;
  if (typeof tooltip !== "object" || tooltip === null || !("formatter" in tooltip)) {
    throw new Error("Expected tooltip.formatter to exist");
  }
  const { formatter } = tooltip;
  if (typeof formatter !== "function") {
    throw new Error("Expected tooltip.formatter to be a function");
  }
  return (params) => {
    const result = formatter(params);
    if (typeof result !== "string") throw new Error("Expected tooltip formatter to return string");
    return result;
  };
}

describe("BodyFatPercentageChart", () => {
  beforeEach(() => {
    capturedOption = null;
  });

  it("renders one body-fat percentage line series with dated values", () => {
    renderWithUnits(<BodyFatPercentageChart data={sampleData} />);

    expect(screen.getByTestId("echarts-mock")).toBeDefined();
    expect(getSeries()).toMatchObject({
      name: "Body Fat %",
      type: "line",
      data: [
        ["2026-02-28", 21.2],
        ["2026-03-01", 20.9],
      ],
    });
  });

  it("labels the body-fat y-axis with a percentage unit", () => {
    renderWithUnits(<BodyFatPercentageChart data={sampleData} />);

    const yAxis = capturedOption?.yAxis;
    if (typeof yAxis !== "object" || yAxis === null || !("name" in yAxis)) {
      throw new Error("Expected a value y-axis");
    }
    expect(yAxis.name).toBe("%");
  });

  it("formats tooltip percentages and dates without floating-point noise", () => {
    renderWithUnits(<BodyFatPercentageChart data={sampleData} />);
    const formatter = getTooltipFormatter();
    const tooltipHtml = formatter([
      {
        seriesName: "Body Fat %",
        marker: '<span style="color:red"></span>',
        data: ["2026-03-01", 20.944],
        value: ["2026-03-01", 20.944],
      },
    ]);

    expect(tooltipHtml).toContain("Mar 1");
    expect(tooltipHtml).toContain("20.9%");
    expect(tooltipHtml).not.toContain("20.944");
  });

  it("shows an explicit insufficient-data message for fewer than two readings", () => {
    const singleRow = sampleData[0];
    if (!singleRow) throw new Error("Expected sample data");

    const { container } = renderWithUnits(<BodyFatPercentageChart data={[singleRow]} />);
    const scoped = within(container);

    expect(scoped.queryByTestId("echarts-mock")).toBeNull();
    expect(scoped.getByText(/at least two body-fat readings/i)).toBeDefined();
  });
});
