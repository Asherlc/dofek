/** @vitest-environment jsdom */

import { chartColors } from "@dofek/scoring/colors";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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

const { BodyRecompositionChart } = await import("./BodyRecompositionChart.tsx");

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
  data: unknown[];
}

const sampleData: BodyRecompositionRow[] = [
  {
    date: "2026-02-28",
    weightKg: 86,
    bodyFatPct: 26,
    fatMassKg: 22.26,
    leanMassKg: 63.74,
    smoothedFatMass: 10.1,
    smoothedLeanMass: 75.9,
  },
  {
    date: "2026-03-01",
    weightKg: 87,
    bodyFatPct: 25,
    fatMassKg: 21.75,
    leanMassKg: 65.25,
    smoothedFatMass: 10.2,
    smoothedLeanMass: 76,
  },
];

function renderWithUnits(children: ReactNode) {
  return render(
    <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
      {children}
    </UnitContext.Provider>,
  );
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

function isNamedSeries(value: unknown): value is NamedSeries {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "data" in value &&
    Array.isArray(value.data)
  );
}

function getSeriesDataPoint(seriesName: string): unknown {
  const series = capturedOption?.series;
  if (!Array.isArray(series)) throw new Error("Expected chart series");
  const chartSeries = series.find(
    (candidate): candidate is NamedSeries =>
      isNamedSeries(candidate) && candidate.name === seriesName,
  );
  const dataPoint = chartSeries?.data[0];
  if (dataPoint == null) throw new Error(`Expected data point for ${seriesName}`);
  return dataPoint;
}

function getDataPointValue(dataPoint: unknown): [string, number] {
  if (
    Array.isArray(dataPoint) &&
    typeof dataPoint[0] === "string" &&
    typeof dataPoint[1] === "number"
  ) {
    return [dataPoint[0], dataPoint[1]];
  }
  if (
    typeof dataPoint === "object" &&
    dataPoint !== null &&
    "value" in dataPoint &&
    Array.isArray(dataPoint.value) &&
    typeof dataPoint.value[0] === "string" &&
    typeof dataPoint.value[1] === "number"
  ) {
    return [dataPoint.value[0], dataPoint.value[1]];
  }
  throw new Error("Expected chart data point value");
}

describe("BodyRecompositionChart", () => {
  it("renders chart with data", () => {
    renderWithUnits(<BodyRecompositionChart data={sampleData} />);
    expect(screen.getByTestId("echarts-mock")).toBeDefined();
    expect(screen.getByText(/Fat:/).style.color).toBe(
      `rgb(${Number.parseInt(chartColors.orange.slice(1, 3), 16)}, ${Number.parseInt(chartColors.orange.slice(3, 5), 16)}, ${Number.parseInt(chartColors.orange.slice(5, 7), 16)})`,
    );
    expect(screen.getByText(/Lean:/).style.color).toBe(
      `rgb(${Number.parseInt(chartColors.blue.slice(1, 3), 16)}, ${Number.parseInt(chartColors.blue.slice(3, 5), 16)}, ${Number.parseInt(chartColors.blue.slice(5, 7), 16)})`,
    );
  });

  it("formats tooltip weights with the shared unit formatter", () => {
    renderWithUnits(<BodyRecompositionChart data={sampleData} />);
    const formatter = getTooltipFormatter();
    const fatMassDataPoint = getSeriesDataPoint("Fat Mass (smoothed)");
    const leanMassDataPoint = getSeriesDataPoint("Lean Mass (smoothed)");
    const tooltipHtml = formatter([
      {
        seriesName: "Fat Mass (smoothed)",
        marker: '<span style="color:red"></span>',
        data: fatMassDataPoint,
        value: getDataPointValue(fatMassDataPoint),
      },
      {
        seriesName: "Lean Mass (smoothed)",
        marker: '<span style="color:blue"></span>',
        data: leanMassDataPoint,
        value: getDataPointValue(leanMassDataPoint),
      },
    ]);

    expect(tooltipHtml).toContain("22.3 lb");
    expect(tooltipHtml).toContain("167.3 lb");
    expect(tooltipHtml).not.toContain("22.266");
    expect(tooltipHtml).not.toContain("167.330658");
  });

  it("shows an insufficient-data message instead of a zero change for a single reading", () => {
    const singleRow = sampleData[0];
    if (!singleRow) throw new Error("Expected sample data");
    const { container } = renderWithUnits(<BodyRecompositionChart data={[singleRow]} />);
    const scoped = within(container);

    expect(scoped.queryByTestId("echarts-mock")).toBeNull();
    expect(scoped.getByText(/at least two weight \+ body fat readings/i)).toBeDefined();
  });
});
