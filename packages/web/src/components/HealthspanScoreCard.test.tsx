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
  {
    name: "Resting Heart Rate",
    value: 58,
    unit: "bpm",
    score: 85,
    status: "excellent",
    yearsDelta: -1.4,
  },
  {
    name: "Heart Rate Variability",
    value: 45,
    unit: "ms",
    score: 60,
    status: "fair",
    yearsDelta: -0.4,
  },
  { name: "VO2 Max", value: 42, unit: "ml/kg/min", score: 70, status: "good", yearsDelta: -0.8 },
];

function makeData(overrides: Partial<HealthspanResult> = {}): HealthspanResult {
  return {
    healthspanScore: 72,
    yearsDelta: -0.9,
    metrics: baseMetrics,
    history: [{ weekStart: "2026-03-01", score: 70 }],
    trend: "stable",
    availability: {
      status: "available",
      availableMetricCount: 3,
      requiredMetricCount: 3,
      missingMetricLabels: [],
      summary: "3 of 3 required Healthspan metrics are available.",
      nextCondition: null,
    },
    ...overrides,
  };
}

describe("HealthspanScoreCard", () => {
  it("renders the canonical loading state when loading", () => {
    render(<HealthspanScoreCard data={undefined} loading={true} />);
    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("renders the canonical empty state when data is undefined", () => {
    render(<HealthspanScoreCard data={undefined} />);
    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("Healthspan availability is unavailable.")).toBeDefined();
  });

  it("renders empty state when healthspanScore is null", () => {
    render(
      <HealthspanScoreCard
        data={makeData({
          healthspanScore: null,
          availability: {
            status: "insufficient_data",
            availableMetricCount: 2,
            requiredMetricCount: 3,
            missingMetricLabels: ["VO2 Max", "Daily Steps"],
            summary: "2 of 3 required Healthspan metrics are available.",
            nextCondition:
              "The score becomes available after 1 more supported metric syncs successfully.",
          },
        })}
      />,
    );

    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("2 of 3 required Healthspan metrics are available.")).toBeDefined();
    expect(
      screen.getByText(
        "The score becomes available after 1 more supported metric syncs successfully.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Missing supported metrics: VO2 Max, Daily Steps")).toBeDefined();
  });

  it("renders empty state when metrics array is empty", () => {
    render(
      <HealthspanScoreCard
        data={makeData({
          healthspanScore: null,
          metrics: [],
          availability: {
            status: "insufficient_data",
            availableMetricCount: 0,
            requiredMetricCount: 3,
            missingMetricLabels: ["Sleep Duration", "Daily Steps", "Resting Heart Rate"],
            summary: "0 of 3 required Healthspan metrics are available.",
            nextCondition:
              "The score becomes available after 3 more supported metrics sync successfully.",
          },
        })}
      />,
    );
    expect(screen.getByText("0 of 3 required Healthspan metrics are available.")).toBeDefined();
  });

  it("displays the healthspan score", () => {
    render(<HealthspanScoreCard data={makeData({ healthspanScore: 72 })} />);
    expect(screen.getByText("72")).toBeDefined();
    expect(screen.getByText("/100")).toBeDefined();
  });

  it("renders metric bars for each metric", () => {
    render(<HealthspanScoreCard data={makeData()} />);
    expect(screen.getByText("Resting Heart Rate")).toBeDefined();
    expect(screen.getByText("Heart Rate Variability")).toBeDefined();
    expect(screen.getByText("VO2 Max")).toBeDefined();
  });

  it("shows metric values with units", () => {
    render(<HealthspanScoreCard data={makeData()} />);
    expect(screen.getByText("58 bpm")).toBeDefined();
    expect(screen.getByText("45 ms")).toBeDefined();
  });

  it("shows dash when metric value is null", () => {
    const metrics: HealthspanMetric[] = [
      { name: "Sleep", value: null, unit: "hrs", score: 50, status: "fair", yearsDelta: 0 },
    ];
    render(<HealthspanScoreCard data={makeData({ metrics })} />);
    expect(screen.getByText("—")).toBeDefined();
  });

  it("renders trend badge when trend is present", () => {
    render(<HealthspanScoreCard data={makeData({ trend: "improving" })} />);
    expect(screen.getByText("Weekly trend across your recorded scores: Improving")).toBeDefined();
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
