/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SleepNeedCard } from "./SleepNeedCard.tsx";

let capturedOption: Record<string, unknown> | null = null;

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOption = props.option;
    return <div data-testid="echarts" />;
  },
}));

const mockData = {
  baselineMinutes: 480,
  strainDebtMinutes: 12,
  accumulatedDebtMinutes: 90,
  totalNeedMinutes: 515,
  canRecommend: true,
  recentNights: [
    { date: "2026-03-14", actualMinutes: 420, neededMinutes: 480, debtMinutes: 60 },
    { date: "2026-03-15", actualMinutes: 500, neededMinutes: 480, debtMinutes: 0 },
    { date: "2026-03-16", actualMinutes: 390, neededMinutes: 480, debtMinutes: 90 },
  ],
};

const barItemSchema = z.object({
  value: z.number(),
  itemStyle: z.object({ color: z.string() }),
});

function getBarSeriesData(): Array<z.infer<typeof barItemSchema>> {
  const series = capturedOption?.series;
  if (Array.isArray(series) && series[0] && "data" in series[0]) {
    return z.array(barItemSchema).parse(series[0].data);
  }
  return [];
}

function getLineSeriesData(): unknown[] {
  const series = capturedOption?.series;
  if (Array.isArray(series) && series[1] && "data" in series[1]) {
    return series[1].data;
  }
  return [];
}

describe("SleepNeedCard", () => {
  it("shows 'No sleep data' when data is undefined", () => {
    render(<SleepNeedCard data={undefined} />);
    expect(screen.getByText("No sleep data")).toBeDefined();
  });

  it("shows loading skeleton when loading", () => {
    render(<SleepNeedCard data={undefined} loading={true} />);
    expect(screen.queryByText("No sleep data")).toBeNull();
  });

  it("renders recommendation header", () => {
    capturedOption = null;
    render(<SleepNeedCard data={mockData} />);
    expect(screen.getByText(/recommended/)).toBeDefined();
  });

  it("passes plain numeric values to bar series (not date tuples)", () => {
    capturedOption = null;
    render(<SleepNeedCard data={mockData} />);
    const bars = getBarSeriesData();
    expect(bars).toHaveLength(3);
    // Each bar value should be a plain number, not a [date, value] tuple
    for (const bar of bars) {
      expect(typeof bar.value).toBe("number");
    }
    expect(bars[0]?.value).toBe(420);
    expect(bars[1]?.value).toBe(500);
    expect(bars[2]?.value).toBe(390);
  });

  it("passes plain numeric values to line series (not date tuples)", () => {
    capturedOption = null;
    render(<SleepNeedCard data={mockData} />);
    const line = getLineSeriesData();
    expect(line).toHaveLength(3);
    // Each line value should be a plain number, not a [date, value] tuple
    for (const val of line) {
      expect(typeof val).toBe("number");
    }
    expect(line[0]).toBe(480);
    expect(line[1]).toBe(480);
    expect(line[2]).toBe(480);
  });

  it("colors bars green when actual >= needed, red when below", () => {
    capturedOption = null;
    render(<SleepNeedCard data={mockData} />);
    const bars = getBarSeriesData();
    // Night 0: 420 < 480 → red
    expect(bars[0]?.itemStyle.color).toBe("#ef4444");
    // Night 1: 500 >= 480 → green
    expect(bars[1]?.itemStyle.color).toBe("#22c55e");
    // Night 2: 390 < 480 → red
    expect(bars[2]?.itemStyle.color).toBe("#ef4444");
  });

  it("renders placeholder bars for null nights (missing data)", () => {
    capturedOption = null;
    const dataWithGaps = {
      ...mockData,
      recentNights: [
        { date: "2026-03-14", actualMinutes: 420, neededMinutes: 480, debtMinutes: 60 },
        { date: "2026-03-15", actualMinutes: null, neededMinutes: 480, debtMinutes: null },
        { date: "2026-03-16", actualMinutes: 390, neededMinutes: 480, debtMinutes: 90 },
      ],
    };
    render(<SleepNeedCard data={dataWithGaps} />);
    const bars = getBarSeriesData();
    expect(bars).toHaveLength(3);
    // Null night should have value 0 and muted color
    expect(bars[1]?.value).toBe(0);
    expect(bars[1]?.itemStyle.color).toBe("#3a3a3e");
  });

  it("shows missing data message when canRecommend is false", () => {
    capturedOption = null;
    const noRecommendData = {
      ...mockData,
      canRecommend: false,
    };
    render(<SleepNeedCard data={noRecommendData} />);
    expect(screen.getByText(/last night/i)).toBeDefined();
    expect(screen.queryByText(/recommended/)).toBeNull();
  });

  it("shows recommendation when canRecommend is true", () => {
    capturedOption = null;
    render(<SleepNeedCard data={mockData} />);
    expect(screen.getByText(/recommended/)).toBeDefined();
  });
});
