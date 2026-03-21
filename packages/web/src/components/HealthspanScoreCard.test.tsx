/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { HealthspanMetric, HealthspanResult } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";
import { HealthspanScoreCard } from "./HealthspanScoreCard.tsx";

vi.mock("echarts-for-react", () => ({
  default: () => {
    return <div data-testid="echarts" />;
  },
}));

const baseMetrics: HealthspanMetric[] = [
  { name: "Resting Heart Rate", value: 58, unit: "bpm", score: 85, status: "excellent" },
  { name: "HRV", value: 45, unit: "ms", score: 60, status: "fair" },
  { name: "VO2 Max", value: 42, unit: "ml/kg/min", score: 70, status: "good" },
];

function makeData(overrides: Partial<HealthspanResult> = {}): HealthspanResult {
  return {
    healthspanScore: 72,
    metrics: baseMetrics,
    history: [{ weekStart: "2026-03-01", score: 70 }],
    trend: "stable",
    ...overrides,
  };
}

describe("HealthspanScoreCard", () => {
  it("renders loading skeleton when loading", () => {
    const { container } = render(<HealthspanScoreCard data={undefined} loading={true} />);
    expect(container.querySelector("[class*='animate-spin']")).not.toBeNull();
  });

  it("renders empty state when data is undefined", () => {
    render(<HealthspanScoreCard data={undefined} />);
    expect(screen.getByText(/Insufficient data for healthspan analysis/)).toBeDefined();
  });

  it("renders empty state when healthspanScore is null", () => {
    render(<HealthspanScoreCard data={makeData({ healthspanScore: null })} />);
    expect(screen.getByText(/Insufficient data for healthspan analysis/)).toBeDefined();
  });

  it("renders empty state when metrics array is empty", () => {
    render(<HealthspanScoreCard data={makeData({ metrics: [] })} />);
    expect(screen.getByText(/Insufficient data for healthspan analysis/)).toBeDefined();
  });

  it("displays the healthspan score", () => {
    render(<HealthspanScoreCard data={makeData({ healthspanScore: 72 })} />);
    expect(screen.getByText("72")).toBeDefined();
    expect(screen.getByText("/100")).toBeDefined();
  });

  it("renders metric bars for each metric", () => {
    render(<HealthspanScoreCard data={makeData()} />);
    expect(screen.getByText("Resting Heart Rate")).toBeDefined();
    expect(screen.getByText("HRV")).toBeDefined();
    expect(screen.getByText("VO2 Max")).toBeDefined();
  });

  it("shows metric values with units", () => {
    render(<HealthspanScoreCard data={makeData()} />);
    expect(screen.getByText("58 bpm")).toBeDefined();
    expect(screen.getByText("45 ms")).toBeDefined();
  });

  it("shows dash when metric value is null", () => {
    const metrics: HealthspanMetric[] = [
      { name: "Sleep", value: null, unit: "hrs", score: 50, status: "fair" },
    ];
    render(<HealthspanScoreCard data={makeData({ metrics })} />);
    expect(screen.getByText("—")).toBeDefined();
  });

  it("renders trend badge when trend is present", () => {
    render(<HealthspanScoreCard data={makeData({ trend: "improving" })} />);
    expect(screen.getByText("Improving")).toBeDefined();
  });

  it("does not render trend badge when trend is null", () => {
    render(<HealthspanScoreCard data={makeData({ trend: null })} />);
    expect(screen.queryByText("Improving")).toBeNull();
    expect(screen.queryByText("Declining")).toBeNull();
    expect(screen.queryByText("Stable")).toBeNull();
  });

  it("renders ECharts radar chart", () => {
    render(<HealthspanScoreCard data={makeData()} />);
    expect(screen.getByTestId("echarts")).toBeDefined();
  });

  describe("score color thresholds match shared scoreColor()", () => {
    it("uses positive color for score above 70", () => {
      const { container } = render(
        <HealthspanScoreCard data={makeData({ healthspanScore: 75 })} />,
      );
      const scoreEl = container.querySelector(".text-5xl");
      expect(scoreEl).not.toBeNull();
      expect(scoreEl?.getAttribute("style")).toContain("color");
    });

    it("uses warning color for score between 50 and 70", () => {
      const { container } = render(
        <HealthspanScoreCard data={makeData({ healthspanScore: 60 })} />,
      );
      const scoreEl = container.querySelector(".text-5xl");
      expect(scoreEl).not.toBeNull();
      expect(scoreEl?.getAttribute("style")).toContain("color");
    });

    it("uses danger color for score below 50", () => {
      const { container } = render(
        <HealthspanScoreCard data={makeData({ healthspanScore: 30 })} />,
      );
      const scoreEl = container.querySelector(".text-5xl");
      expect(scoreEl).not.toBeNull();
      expect(scoreEl?.getAttribute("style")).toContain("color");
    });
  });
});
