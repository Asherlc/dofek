/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import { render, screen } from "@testing-library/react";
import type { ActivityComparisonRow } from "dofek-server/types";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { ActivityComparisonChart } from "./ActivityComparisonChart.tsx";

let capturedOption: Record<string, unknown> | null = null;

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOption = props.option;
    return <div data-testid="echarts" />;
  },
}));

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOption = null;
  return render(
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {ui}
    </UnitContext.Provider>,
  );
}

function getYAxisName(): string {
  const yAxis = capturedOption?.yAxis;
  if (yAxis && typeof yAxis === "object" && "name" in yAxis) {
    return String(yAxis.name);
  }
  return "";
}

function getFirstSeriesData(): Array<[string, number]> {
  const series = capturedOption?.series;
  if (Array.isArray(series) && series[0] && "data" in series[0]) {
    return series[0].data;
  }
  return [];
}

function isTooltipFormatter(value: unknown): value is (params: Record<string, unknown>) => unknown {
  return typeof value === "function";
}

function getTooltipFormatter(): (params: Record<string, unknown>) => unknown {
  const tooltip = capturedOption?.tooltip;
  if (
    !tooltip ||
    typeof tooltip !== "object" ||
    !("formatter" in tooltip) ||
    !isTooltipFormatter(tooltip.formatter)
  ) {
    throw new Error("Expected tooltip formatter");
  }
  return tooltip.formatter;
}

const mockData = [
  {
    activityName: "Park Loop",
    instances: [
      {
        date: "2026-03-10",
        averagePaceMinPerKm: 5,
        durationMinutes: 25,
        avgHeartRate: 150,
        elevationGainMeters: 50,
      },
      {
        date: "2026-03-15",
        averagePaceMinPerKm: 4.8,
        durationMinutes: 24,
        avgHeartRate: 148,
        elevationGainMeters: 50,
      },
    ],
  },
] satisfies [ActivityComparisonRow];

describe("ActivityComparisonChart", () => {
  it("shows empty state when no data", () => {
    renderWithUnits(<ActivityComparisonChart data={[]} />);
    expect(screen.getByText(/No repeated routes found/)).toBeDefined();
  });

  it("shows loading state", () => {
    const { container } = renderWithUnits(<ActivityComparisonChart data={[]} loading={true} />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("uses /km pace label for metric", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "metric");
    expect(capturedOption).not.toBeNull();
    expect(getYAxisName()).toContain("/km");
  });

  it("uses /mi pace label for imperial", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "imperial");
    expect(capturedOption).not.toBeNull();
    expect(getYAxisName()).toContain("/mi");
  });

  it("converts pace values to imperial in series data", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "imperial");
    const data = getFirstSeriesData();
    const first = data[0];
    if (!first) throw new Error("Expected series data");
    expect(first[1]).toBeGreaterThan(400);
    expect(first[1]).toBeLessThan(500);
  });

  it("keeps pace values in metric unchanged", () => {
    renderWithUnits(<ActivityComparisonChart data={mockData} />, "metric");
    const data = getFirstSeriesData();
    const first = data[0];
    if (!first) throw new Error("Expected series data");
    expect(first[1]).toBe(300);
  });

  it("escapes provider-controlled route names in HTML tooltips", () => {
    const maliciousName =
      'Route <a href="javascript:alert(1)" onmouseover="alert(\'x\')">click</a> & "quoted"';
    renderWithUnits(
      <ActivityComparisonChart data={[{ ...mockData[0], activityName: maliciousName }]} />,
    );

    const html = String(
      getTooltipFormatter()({
        value: ["2026-03-10", 300],
        seriesName: maliciousName,
      }),
    );

    expect(html).toContain(
      "Route &lt;a href=&quot;javascript:alert(1)&quot; onmouseover=&quot;alert(&#39;x&#39;)&quot;&gt;click&lt;/a&gt; &amp; &quot;quoted&quot;",
    );
    expect(html).not.toContain("<a ");
  });
});
