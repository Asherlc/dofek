/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    style,
  }: {
    option: Record<string, unknown>;
    style: Record<string, unknown>;
  }) => (
    <div
      data-testid="echarts-mock"
      data-option={JSON.stringify(option)}
      style={style satisfies React.CSSProperties}
    />
  ),
}));

vi.mock("./LoadingSkeleton.tsx", () => ({
  ChartLoadingSkeleton: ({ height }: { height: number }) => (
    <div data-testid="loading-skeleton" style={{ height }} />
  ),
}));

const { AerobicEfficiencyChart } = await import("./AerobicEfficiencyChart.tsx");

describe("AerobicEfficiencyChart", () => {
  it("renders empty state without crashing when activities is empty", () => {
    // This was the bug: empty activities caused new Date(Infinity).toISOString()
    // to throw RangeError: Invalid time value
    expect(() => {
      render(<AerobicEfficiencyChart activities={[]} maxHr={null} />);
    }).not.toThrow();

    expect(
      screen.getByText("No activities with sufficient Zone 2 power + heart rate data"),
    ).toBeDefined();
  });

  it("renders loading state", () => {
    render(<AerobicEfficiencyChart activities={[]} maxHr={null} loading={true} />);
    expect(screen.getByTestId("loading-skeleton")).toBeDefined();
  });

  it("renders chart when activities are provided", () => {
    const activities = [
      {
        date: "2026-03-10",
        activityType: "cycling",
        name: "Morning Ride",
        avgPowerZ2: 180,
        avgHrZ2: 135,
        efficiencyFactor: 1.333,
        z2Samples: 600,
      },
      {
        date: "2026-03-15",
        activityType: "cycling",
        name: "Evening Ride",
        avgPowerZ2: 185,
        avgHrZ2: 133,
        efficiencyFactor: 1.391,
        z2Samples: 900,
      },
    ];

    render(<AerobicEfficiencyChart activities={activities} maxHr={190} />);
    expect(screen.getByTestId("echarts-mock")).toBeDefined();
    expect(screen.getByText(/Trend:/)).toBeDefined();
  });

  it("does not show Invalid Date in rendered output", () => {
    render(<AerobicEfficiencyChart activities={[]} maxHr={null} />);
    expect(screen.queryByText("Invalid Date")).toBeNull();
  });
});
