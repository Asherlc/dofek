/** @vitest-environment jsdom */

import type { HealthExplorerSnapshot } from "@dofek/mcp-contracts/health-explorer";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HealthExplorer } from "./health-explorer.tsx";

const { mockInit } = vi.hoisted(() => ({
  mockInit: vi.fn(() => ({ dispose: vi.fn(), setOption: vi.fn() })),
}));

vi.mock("echarts/core", () => ({ init: mockInit, use: vi.fn() }));

const snapshot: HealthExplorerSnapshot = {
  range: {
    start_date: "2026-08-01",
    end_date: "2026-08-03",
    granularity: "daily",
    timezone: "America/Los_Angeles",
  },
  series: [
    {
      metric: "hrv",
      label: "Heart rate variability",
      unit: "ms",
      points: [
        { key: "2026-08-01", value: 41 },
        { key: "2026-08-02", value: null },
        { key: "2026-08-03", value: 44 },
      ],
    },
    {
      metric: "resting_hr",
      label: "Resting heart rate",
      unit: "bpm",
      points: [{ key: "2026-08-01", value: 58 }],
    },
  ],
  summary: [
    { metric: "hrv", average: 42.5, min: 41, max: 44 },
    { metric: "resting_hr", average: 58, min: 58, max: 58 },
  ],
  coverage: { requested_days: 3, observed_days: 2 },
};

describe("HealthExplorer", () => {
  it("renders server-provided summaries and requests a selected metric", () => {
    const onMetricChange = vi.fn();

    render(<HealthExplorer snapshot={snapshot} onMetricChange={onMetricChange} />);

    expect(screen.getByRole("heading", { name: "Dofek Analytics Explorer" })).toBeDefined();
    expect(screen.getByText("42.5")).toBeDefined();
    expect(screen.getByText("2 of 3 days observed")).toBeDefined();
    expect(screen.getAllByRole("option")).toHaveLength(10);

    fireEvent.change(screen.getByRole("combobox", { name: "Metric" }), {
      target: { value: "resting_hr" },
    });

    expect(onMetricChange).toHaveBeenCalledWith("resting_hr");
  });

  it("renders an empty server response without initializing a chart", () => {
    mockInit.mockClear();

    render(
      <HealthExplorer
        snapshot={{
          ...snapshot,
          series: [],
          summary: [{ metric: "hrv", average: null, min: null, max: null }],
          coverage: { requested_days: 3, observed_days: 0 },
        }}
        onMetricChange={vi.fn()}
      />,
    );

    expect(screen.getByText("No data")).toBeDefined();
    expect(screen.getByText("0 of 3 days observed")).toBeDefined();
    expect(mockInit).not.toHaveBeenCalled();
  });
});
