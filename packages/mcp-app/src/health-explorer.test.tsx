/** @vitest-environment jsdom */

import type { HealthExplorerSnapshot } from "@dofek/mcp-contracts/health-explorer";
import { applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      note: null,
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
      note: null,
      points: [{ key: "2026-08-01", value: 58 }],
    },
  ],
  summary: [
    { metric: "hrv", average: 42.5, min: 41, max: 44 },
    { metric: "resting_hr", average: 58, min: 58, max: 58 },
  ],
  coverage: {
    requested_days: 3,
    by_metric: {
      hrv: {
        observed_days: 2,
        missing_days: ["2026-08-02"],
        missing_days_truncated_count: 0,
      },
      resting_hr: {
        observed_days: 1,
        missing_days: ["2026-08-02", "2026-08-03"],
        missing_days_truncated_count: 0,
      },
    },
  },
};

describe("HealthExplorer", () => {
  beforeEach(() => {
    mockInit.mockClear();
    applyDocumentTheme("light");
  });

  afterEach(() => {
    applyDocumentTheme("light");
  });

  it.each(["light", "dark"] as const)("renders the chart for the %s host theme", (theme) => {
    applyDocumentTheme(theme);

    render(<HealthExplorer snapshot={snapshot} onMetricChange={vi.fn()} />);

    expect(mockInit).toHaveBeenCalledWith(
      screen.getByRole("img", { name: "Health trend chart" }),
      theme === "dark" ? "dark" : undefined,
    );
    expect(mockInit.mock.results[0]?.value.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ backgroundColor: "transparent" }),
    );
  });

  it("updates the chart when the host switches from dark to light", async () => {
    applyDocumentTheme("dark");
    const { unmount } = render(<HealthExplorer snapshot={snapshot} onMetricChange={vi.fn()} />);
    const darkChart = mockInit.mock.results[0]?.value;

    await act(async () => {
      applyDocumentTheme("light");
    });

    await waitFor(() => {
      expect(mockInit).toHaveBeenLastCalledWith(
        screen.getByRole("img", { name: "Health trend chart" }),
        undefined,
      );
    });
    expect(darkChart?.dispose).toHaveBeenCalledOnce();
    expect(mockInit.mock.results[1]?.value.setOption).toHaveBeenCalledWith(
      expect.objectContaining({ backgroundColor: "transparent" }),
    );

    const lightChart = mockInit.mock.results[1]?.value;
    unmount();
    expect(lightChart?.dispose).toHaveBeenCalledOnce();
  });

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
          coverage: {
            requested_days: 3,
            by_metric: {
              hrv: {
                observed_days: 0,
                missing_days: ["2026-08-01", "2026-08-02", "2026-08-03"],
                missing_days_truncated_count: 0,
              },
            },
          },
        }}
        onMetricChange={vi.fn()}
      />,
    );

    expect(screen.getByText("No data")).toBeDefined();
    expect(screen.getByText("0 of 3 days observed")).toBeDefined();
    expect(mockInit).not.toHaveBeenCalled();
  });
});
