/** @vitest-environment jsdom */
import { statusColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { MISSING_PREVIOUS_NIGHT_MESSAGE, type SleepNeedV2 } from "dofek-server/sleep-need-contract";
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

const emptyProvenance: Pick<
  Extract<SleepNeedV2, { availability: "available" }>["recentNights"][number],
  "providerId" | "sourceName" | "sourceProviders"
> = {
  providerId: null,
  sourceName: null,
  sourceProviders: [],
};

const mockData = {
  availability: "available" as const,
  baselineMinutes: 480,
  strainDebtMinutes: 12,
  accumulatedDebtMinutes: 90,
  debtRecoveryMinutes: 23,
  totalNeedMinutes: 515,
  estimateMetadata: {
    basis: "generic_eight_hour_default" as const,
    baselineQualifyingNightCount: 1,
    debtObservedNightCount: 1,
    methodVersion: "sleep-need-heuristic-v1" as const,
    uncertainty: "not_established" as const,
    valueQualifier: "About" as const,
    summaryLabel: "Heuristic estimate" as const,
    componentLabels: {
      baseline: "Baseline estimate" as const,
      strainDebt: "Previous-day load adjustment" as const,
      debtRecovery: "Debt recovery" as const,
    },
    basisLabel:
      "Baseline uses a generic 8-hour default because 1 qualifying night is below the 7-night minimum.",
    coverageLabel: "Sleep-debt input uses 1 observed night from the model's recent-night window.",
    methodLabel: "Method: sleep-need-heuristic-v1" as const,
    uncertaintyLabel: "Uncertainty: not established" as const,
    limitationLabel:
      "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established." as const,
  },
  recentNights: [
    {
      date: "2026-03-14",
      actualMinutes: 420,
      neededMinutes: 480,
      debtMinutes: 60,
      ...emptyProvenance,
    },
    {
      date: "2026-03-15",
      actualMinutes: 500,
      neededMinutes: 480,
      debtMinutes: 0,
      ...emptyProvenance,
    },
    {
      date: "2026-03-16",
      actualMinutes: 390,
      neededMinutes: 480,
      debtMinutes: 90,
      ...emptyProvenance,
    },
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

  it("presents the available value as an uncalibrated heuristic estimate", () => {
    capturedOption = null;
    render(<SleepNeedCard data={mockData} />);
    expect(screen.getByText("About 8h 35m")).toBeDefined();
    expect(screen.getByText("Heuristic estimate")).toBeDefined();
    expect(screen.getByText("Previous-day load adjustment")).toBeDefined();
    expect(screen.getByText("Uncertainty: not established")).toBeDefined();
    expect(
      screen.getByText(
        "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/recommended/)).toBeNull();
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
    expect(bars[0]?.itemStyle.color).toBe(statusColors.danger);
    // Night 1: 500 >= 480 → green
    expect(bars[1]?.itemStyle.color).toBe(statusColors.positive);
    // Night 2: 390 < 480 → red
    expect(bars[2]?.itemStyle.color).toBe(statusColors.danger);
  });

  it("renders placeholder bars for null nights (missing data)", () => {
    capturedOption = null;
    const dataWithGaps = {
      ...mockData,
      recentNights: [
        {
          date: "2026-03-14",
          actualMinutes: 420,
          neededMinutes: 480,
          debtMinutes: 60,
          ...emptyProvenance,
        },
        {
          date: "2026-03-15",
          actualMinutes: null,
          neededMinutes: 480,
          debtMinutes: null,
          ...emptyProvenance,
        },
        {
          date: "2026-03-16",
          actualMinutes: 390,
          neededMinutes: 480,
          debtMinutes: 90,
          ...emptyProvenance,
        },
      ],
    };
    render(<SleepNeedCard data={dataWithGaps} />);
    const bars = getBarSeriesData();
    expect(bars).toHaveLength(3);
    // Null night should have value 0 and muted color
    expect(bars[1]?.value).toBe(0);
    expect(bars[1]?.itemStyle.color).toBe("#3a3a3e");
  });

  it("shows only the server message when previous-night sleep is missing", () => {
    capturedOption = null;
    const unavailableData: SleepNeedV2 = {
      availability: "missing_previous_night",
      message: MISSING_PREVIOUS_NIGHT_MESSAGE,
    };
    render(<SleepNeedCard data={unavailableData} />);
    expect(screen.getByText(MISSING_PREVIOUS_NIGHT_MESSAGE)).toBeDefined();
    expect(screen.queryByText(/recommended/)).toBeNull();
    expect(screen.queryByText("Baseline")).toBeNull();
    expect(screen.queryByText("Strain Debt")).toBeNull();
    expect(screen.queryByText("Sleep Debt")).toBeNull();
    expect(screen.queryByTestId("echarts")).toBeNull();
  });

  it("shows the available estimate basis and coverage", () => {
    capturedOption = null;
    render(<SleepNeedCard data={mockData} />);
    expect(
      screen.getByText(
        "Baseline uses a generic 8-hour default because 1 qualifying night is below the 7-night minimum.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Sleep-debt input uses 1 observed night from the model's recent-night window.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Method: sleep-need-heuristic-v1")).toBeDefined();
  });
});
