// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { init, setPlatformAPI } from "echarts";
import type { ReactNode } from "react";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

const chartOptions = vi.hoisted(() => vi.fn());
vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    option,
    empty,
    emptyMessage,
    loading,
    dataDisclosure,
  }: {
    option: Record<string, unknown>;
    empty?: boolean;
    emptyMessage?: string;
    loading?: boolean;
    dataDisclosure?: ReactNode;
  }) => {
    chartOptions(option);
    return <div>{loading ? "Loading chart" : empty ? emptyMessage : dataDisclosure}</div>;
  },
}));

import { Hypnogram } from "./Hypnogram.tsx";

const stages = [
  {
    stage: "deep",
    started_at: "2026-11-15T23:00:00Z",
    ended_at: "2026-11-15T23:30:00Z",
    duration_seconds: 1800,
  },
  {
    stage: "awake",
    started_at: "2026-11-16T00:00:00Z",
    ended_at: "2026-11-16T00:02:00Z",
    duration_seconds: 120,
  },
  {
    stage: "rem",
    started_at: "2026-11-16T00:02:00Z",
    ended_at: "2026-11-16T01:00:00Z",
    duration_seconds: 3480,
  },
  {
    stage: "light",
    started_at: "2026-11-16T01:00:00Z",
    ended_at: "2026-11-16T02:00:00Z",
    duration_seconds: 3600,
  },
];
function renderChart() {
  setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 7 }) });
  const chart = init(null, null, { renderer: "svg", ssr: true, width: 900, height: 240 });
  chart.setOption({ ...chartOptions.mock.lastCall?.[0], animation: false });
  return chart;
}
describe("Hypnogram", () => {
  it("exposes recorded seconds in interval boundaries and duration", () => {
    render(
      <Hypnogram
        data={[
          {
            stage: "awake",
            started_at: "2026-11-15T23:00:15",
            ended_at: "2026-11-15T23:01:30",
            duration_seconds: 75,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("View chart data"));
    fireEvent.click(screen.getByRole("button", { name: /Awake/ }));
    expect(screen.getByRole("status").textContent).toContain("1m 15s");
    expect(screen.getByRole("status").textContent).toContain("11:00:15 PM");
    expect(screen.getByRole("status").textContent).toContain("11:01:30 PM");
    expect(screen.getByRole("cell", { name: "1m 15s" })).toBeDefined();
  });

  it("draws opaque intervals only in their own lane and leaves missing time blank", async () => {
    render(<Hypnogram data={stages} />);
    const chart = renderChart();
    try {
      const svgText = chart.renderToSVGString();
      const svg = new DOMParser().parseFromString(svgText, "image/svg+xml");
      expect(Array.from(svg.querySelectorAll("text"), (node) => node.textContent)).toEqual(
        expect.arrayContaining(["Awake", "REM", "Light", "Deep"]),
      );
      const raster = await sharp(Buffer.from(svgText))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      function pixel(time: string, lane: number) {
        const [pixelX = 0, pixelY = 0] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [
          Date.parse(time),
          lane,
        ]);
        const offset =
          (Math.round(pixelY) * raster.info.width + Math.round(pixelX)) * raster.info.channels;
        return Array.from(raster.data.subarray(offset, offset + 4));
      }
      expect(pixel("2026-11-15T23:15:00Z", 3)).toEqual([94, 53, 177, 255]);
      expect(pixel("2026-11-16T00:01:00Z", 0)).toEqual([255, 138, 101, 255]);
      expect(pixel("2026-11-16T00:30:00Z", 1)).toEqual([66, 165, 245, 255]);
      expect(pixel("2026-11-16T01:30:00Z", 2)).toEqual([120, 144, 156, 255]);
      for (const lane of [0, 1, 2, 3])
        expect(pixel("2026-11-15T23:45:00Z", lane)[3]).toBeLessThan(50);
      expect(pixel("2026-11-16T00:30:00Z", 3)[3]).toBeLessThan(50);
      expect(pixel("2026-11-15T23:29:00Z", 3)[3]).toBe(255);
      expect(pixel("2026-11-15T23:31:00Z", 3)[3]).toBeLessThan(50);
    } finally {
      chart.dispose();
    }
  });
  it("keeps all four lanes for a single-stage night", () => {
    render(<Hypnogram data={stages.slice(0, 1)} />);
    const chart = renderChart();
    try {
      const svg = new DOMParser().parseFromString(chart.renderToSVGString(), "image/svg+xml");
      expect(Array.from(svg.querySelectorAll("text"), (node) => node.textContent)).toEqual(
        expect.arrayContaining(["Awake", "REM", "Light", "Deep"]),
      );
      expect(svg.querySelector('path[fill="#5E35B1"]')).not.toBeNull();
      expect(chart.renderToSVGString()).not.toContain("NaN");
    } finally {
      chart.dispose();
    }
  });
  it("provides exact intervals and keyboard-selectable durations, clearing selection for a new night", () => {
    const { rerender } = render(<Hypnogram data={stages} />);
    fireEvent.click(screen.getByText("View chart data"));
    fireEvent.click(screen.getByRole("button", { name: /Awake/ }));
    expect(screen.getByRole("button", { name: /Awake/ }).getAttribute("aria-pressed")).toBe("true");
    const selectedChart = renderChart();
    try {
      const svg = new DOMParser().parseFromString(
        selectedChart.renderToSVGString(),
        "image/svg+xml",
      );
      expect(svg.querySelector('path[fill="#FF8A65"][stroke="#1a2e1a"]')).not.toBeNull();
    } finally {
      selectedChart.dispose();
    }
    expect(screen.getByRole("status").textContent).toContain("Awake");
    expect(screen.getByRole("status").textContent).toContain("2m");
    expect(screen.getAllByRole("row")).toHaveLength(5);
    rerender(<Hypnogram data={stages.slice(0, 1)} />);
    expect(screen.getByRole("status").textContent).toContain("Select a sleep stage");
  });
  it("shows empty and loading states", () => {
    const { rerender } = render(<Hypnogram data={[]} />);
    expect(screen.getByText("No sleep stage data available")).toBeTruthy();
    rerender(<Hypnogram data={[]} loading />);
    expect(screen.getByText("Loading chart")).toBeTruthy();
  });
});
