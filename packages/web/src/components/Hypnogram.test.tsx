// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { init, setPlatformAPI } from "echarts";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

const chartOptions = vi.hoisted(() => vi.fn());

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    option,
    empty,
    emptyMessage,
    loading,
  }: {
    option: Record<string, unknown>;
    empty?: boolean;
    emptyMessage?: string;
    loading?: boolean;
  }) => {
    chartOptions(option);
    return <div>{loading ? "Loading chart" : empty ? emptyMessage : "Sleep timeline"}</div>;
  },
}));

import { Hypnogram } from "./Hypnogram.tsx";

describe("Hypnogram", () => {
  it("renders stage labels and a visible timeline from timestamped intervals", () => {
    render(
      <Hypnogram
        data={[
          { stage: "light", started_at: "2026-11-15T07:09:33Z", ended_at: "2026-11-15T07:58:45Z" },
          { stage: "awake", started_at: "2026-11-15T07:58:45Z", ended_at: "2026-11-15T07:59:45Z" },
          { stage: "deep", started_at: "2026-11-15T07:59:45Z", ended_at: "2026-11-15T08:55:18Z" },
          { stage: "rem", started_at: "2026-11-15T08:55:18Z", ended_at: "2026-11-15T09:14:49Z" },
        ]}
      />,
    );

    setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 7 }) });
    const chart = init(null, null, { renderer: "svg", ssr: true, width: 900, height: 200 });
    try {
      chart.setOption({ ...chartOptions.mock.lastCall?.[0], animation: false });
      const svg = new DOMParser().parseFromString(chart.renderToSVGString(), "image/svg+xml");
      const labels = Array.from(svg.querySelectorAll("text"), (node) => node.textContent);
      expect(labels).toEqual(expect.arrayContaining(["Deep", "Light", "REM", "Awake"]));
      expect(labels.some((label) => /\d{1,2}:\d{2}/.test(label ?? ""))).toBe(true);
      const seriesPaths = svg.querySelectorAll('path[stroke-width="2"]');
      expect(seriesPaths.length).toBeGreaterThan(0);
      expect(seriesPaths[0]?.getAttribute("d")).toMatch(/L/);
      expect(seriesPaths[0]?.getAttribute("d")).not.toContain("NaN");
    } finally {
      chart.dispose();
    }
  });

  it("draws opaque stage-colored lines rather than transparent zero-width color bands", async () => {
    render(
      <Hypnogram
        data={[
          { stage: "light", started_at: "2026-11-15T07:09:33Z", ended_at: "2026-11-15T07:58:45Z" },
          { stage: "awake", started_at: "2026-11-15T07:58:45Z", ended_at: "2026-11-15T08:55:18Z" },
        ]}
      />,
    );
    setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 7 }) });
    const chart = init(null, null, { renderer: "svg", ssr: true, width: 900, height: 200 });
    try {
      chart.setOption({ ...chartOptions.mock.lastCall?.[0], animation: false });
      const { data, info } = await sharp(Buffer.from(chart.renderToSVGString()))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let opaqueStagePixels = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        const isLight =
          data[offset] === 120 && data[offset + 1] === 144 && data[offset + 2] === 156;
        const isAwake =
          data[offset] === 255 && data[offset + 1] === 138 && data[offset + 2] === 101;
        if ((data[offset + 3] ?? 0) > 200 && (isLight || isAwake)) opaqueStagePixels++;
      }
      expect(opaqueStagePixels).toBeGreaterThan(500);
    } finally {
      chart.dispose();
    }
  });

  it("shows the empty state when no intervals exist", () => {
    render(<Hypnogram data={[]} />);
    expect(screen.getByText("No sleep stage data available")).toBeTruthy();
  });
});
