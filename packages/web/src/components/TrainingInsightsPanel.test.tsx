/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { type EChartsOption, init, setPlatformAPI } from "echarts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRegistryInputs,
  resetRangePlumbingState,
  state,
} from "../routes/training/range-plumbing.test-helper.tsx";
import { buildChartTable } from "./chart-accessibility.ts";

const chartOptions = vi.fn<(option: EChartsOption) => void>();
vi.doMock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: EChartsOption }) => {
    chartOptions(option);
    return <div />;
  },
}));

const { TrainingInsightsPanel } = await import("./TrainingInsightsPanel.tsx");

describe("TrainingInsightsPanel range plumbing", () => {
  beforeEach(() => {
    resetRangePlumbingState();
    chartOptions.mockClear();
  });
  afterEach(cleanup);

  it("passes finite and All ranges to selected-range chart queries", () => {
    render(<TrainingInsightsPanel days={30} />);
    expectRegistryInputs("trainingInsightsPanel", 30);

    cleanup();
    state.queryCalls.length = 0;
    render(<TrainingInsightsPanel days={null} />);
    expectRegistryInputs("trainingInsightsPanel", null);
  });

  it("renders the zone distribution with its calculation method", () => {
    state.trainingHrZonesQuery = {
      data: {
        maxHr: 190,
        weeks: [
          {
            max_hr: 190,
            week: "2026-07-20",
            zone0: 0,
            zone1: 600,
            zone2: 1200,
            zone3: 300,
            zone4: 200,
            zone5: 100,
          },
        ],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 2400,
          zones: [
            { zone: 1, label: "Recovery", seconds: 600, percent: 25 },
            { zone: 2, label: "Aerobic", seconds: 1200, percent: 50 },
          ],
          explanation: "Server says this is descriptive and is not a polarization classification.",
        },
      },
      isLoading: false,
      error: null,
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Heart-rate zone distribution")).toBeDefined();
    expect(screen.getByText("Heart-rate zone distribution")).toBeDefined();

    expect(screen.getByRole("button", { name: "About this chart" })).toHaveAttribute(
      "data-description",
      expect.stringContaining("Karvonen"),
    );
  });

  it("keeps recorded zones readable in a narrow donut and zero time in the chart data", () => {
    state.trainingHrZonesQuery = {
      data: {
        maxHr: 190,
        weeks: [
          { week: "2026-07-20", zone0: 34, zone1: 18, zone2: 24, zone3: 19, zone4: 5, zone5: 0 },
        ],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 100,
          zones: [
            { zone: 0, label: "Below Zone 1", seconds: 34, percent: 34 },
            { zone: 1, label: "Recovery", seconds: 18, percent: 18 },
            { zone: 2, label: "Aerobic", seconds: 24, percent: 24 },
            { zone: 3, label: "Tempo", seconds: 19, percent: 19 },
            { zone: 4, label: "Threshold", seconds: 5, percent: 5 },
            { zone: 5, label: "VO2max", seconds: 0, percent: 0 },
          ],
          explanation: "Observed intensity distribution.",
        },
      },
      isLoading: false,
      error: null,
    };

    render(<TrainingInsightsPanel days={30} />);

    const option = chartOptions.mock.lastCall?.[0];
    expect(option).toBeDefined();
    setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 6 }) });
    const chart = init(null, null, { renderer: "svg", ssr: true, width: 320, height: 200 });
    try {
      chart.setOption({ ...option, animation: false });
      const svg = new DOMParser().parseFromString(chart.renderToSVGString(), "image/svg+xml");
      const labels = Array.from(svg.querySelectorAll("text"), (node) => node.textContent).join(" ");
      expect(labels).not.toContain("VO2max");
      expect(labels).toMatch(/Zone 2:\s+Aerobic/);
      expect(buildChartTable({ ...option }).rows).toContainEqual(
        expect.objectContaining({ category: "Zone 5: VO2max", value: "0" }),
      );
    } finally {
      chart.dispose();
    }
  });

  it("renders query failures separately from an empty period", () => {
    state.trainingVolumeQuery = {
      data: undefined,
      isLoading: false,
      error: new Error("Weekly volume query failed"),
    };
    state.trainingHrZonesQuery = {
      data: undefined,
      isLoading: false,
      error: new Error("Heart-rate zones query failed"),
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Weekly volume query failed")).toBeDefined();
    expect(screen.getByText("Heart-rate zones query failed")).toBeDefined();
    expect(screen.queryByText("No training data in this period")).toBeNull();
  });

  it("shows an initial loading state while both training queries are unresolved", () => {
    state.trainingVolumeQuery = { data: undefined, isLoading: true, error: null };
    state.trainingHrZonesQuery = { data: undefined, isLoading: true, error: null };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Loading training data...")).toBeDefined();
  });

  it("keeps available heart-rate-zone data visible while weekly volume is loading", () => {
    state.trainingVolumeQuery = { data: undefined, isLoading: true, error: null };
    state.trainingHrZonesQuery = {
      data: {
        maxHr: 190,
        weeks: [
          {
            max_hr: 190,
            week: "2026-07-20",
            zone0: 0,
            zone1: 600,
            zone2: 1200,
            zone3: 300,
            zone4: 200,
            zone5: 100,
          },
        ],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 2400,
          zones: [{ zone: 2, label: "Aerobic", seconds: 1200, percent: 50 }],
          explanation: "Observed intensity distribution.",
        },
      },
      isLoading: false,
      error: null,
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Loading weekly volume...")).toBeDefined();
    expect(screen.getByText("Heart-rate zone distribution")).toBeDefined();
  });

  it("keeps available weekly volume visible while heart-rate zones are loading", () => {
    state.trainingVolumeQuery = {
      data: [{ week: "2026-07-20", canonical_type: "cycling", count: 1, hours: 2 }],
      isLoading: false,
      error: null,
    };
    state.trainingHrZonesQuery = { data: undefined, isLoading: true, error: null };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Weekly Training Volume")).toBeDefined();
    expect(screen.getByText("Loading heart-rate zones...")).toBeDefined();
  });

  it("omits the intensity distribution when the server reports no recorded zone time", () => {
    state.trainingHrZonesQuery = {
      data: {
        maxHr: 190,
        weeks: [
          {
            max_hr: 190,
            week: "2026-07-20",
            zone0: 0,
            zone1: 0,
            zone2: 0,
            zone3: 0,
            zone4: 0,
            zone5: 0,
          },
        ],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 0,
          zones: [],
          explanation: "No recorded zone time.",
        },
      },
      isLoading: false,
      error: null,
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.queryByText("Heart-rate zone distribution")).toBeNull();
  });

  it("keeps cached training data visible with background query failures", () => {
    state.trainingVolumeQuery = {
      data: [{ week: "2026-07-20", canonical_type: "cycling", count: 1, hours: 2 }],
      isLoading: false,
      error: new Error("Weekly volume refresh failed"),
    };
    state.trainingHrZonesQuery = {
      data: {
        maxHr: 190,
        weeks: [
          {
            max_hr: 190,
            week: "2026-07-20",
            zone0: 0,
            zone1: 600,
            zone2: 1200,
            zone3: 300,
            zone4: 200,
            zone5: 100,
          },
        ],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 2400,
          zones: [{ zone: 2, label: "Aerobic", seconds: 1200, percent: 50 }],
          explanation: "Cached intensity distribution.",
        },
      },
      isLoading: false,
      error: new Error("Heart-rate zones refresh failed"),
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Weekly volume refresh failed")).toBeDefined();
    expect(screen.getByText("Heart-rate zones refresh failed")).toBeDefined();
    expect(screen.getByText("Weekly Training Volume")).toBeDefined();
    expect(screen.getByText("Heart-rate zone distribution")).toBeDefined();
  });
});
