// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { init, setPlatformAPI } from "echarts";
import { afterEach, describe, expect, it, vi } from "vitest";

const chartOptions = vi.hoisted(() => vi.fn());

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    empty,
    emptyMessage,
    loading,
    option,
  }: {
    empty?: boolean;
    emptyMessage?: string;
    loading?: boolean;
    option: Record<string, unknown>;
  }) => {
    chartOptions(option);
    return (
      <div data-testid="chart">
        {loading ? "Loading chart" : empty ? emptyMessage : "volume chart"}
      </div>
    );
  },
}));

import { ClimbingVolumeByGradeChart } from "./ClimbingVolumeByGradeChart.tsx";

afterEach(cleanup);

describe("ClimbingVolumeByGradeChart", () => {
  it("renders an empty state when no grade volume rows exist", () => {
    render(<ClimbingVolumeByGradeChart data={[]} />);

    expect(screen.getByText("No climbing volume by grade")).toBeTruthy();
  });

  it("passes loading state to the chart", () => {
    render(<ClimbingVolumeByGradeChart data={[]} loading />);

    expect(screen.getByText("Loading chart")).toBeTruthy();
  });

  it("plots unknown attempts as gaps while retaining known sends and zero attempts", () => {
    render(
      <ClimbingVolumeByGradeChart
        data={[
          {
            climbKind: "boulder",
            gradeSystem: "v_scale",
            grade: "VB",
            gradeSortValue: -1,
            attempts: null,
            recordedAttempts: null,
            sends: 1,
          },
          {
            climbKind: "boulder",
            gradeSystem: "v_scale",
            grade: "V0",
            gradeSortValue: 0,
            attempts: 0,
            recordedAttempts: 0,
            sends: 0,
          },
        ]}
      />,
    );

    expect(chartOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: expect.arrayContaining([
          expect.objectContaining({ name: "Recorded attempts", data: [null, 0] }),
          expect.objectContaining({ name: "Sends", data: [1, 0] }),
        ]),
      }),
    );
  });

  it("plots per-grade sends and attempts ordered by sort value", () => {
    render(
      <ClimbingVolumeByGradeChart
        data={[
          {
            climbKind: "boulder",
            gradeSystem: "v_scale",
            grade: "V4",
            gradeSortValue: 4,
            attempts: 3,
            recordedAttempts: 3,
            sends: 2,
          },
          {
            climbKind: "boulder",
            gradeSystem: "v_scale",
            grade: "V1",
            gradeSortValue: 1,
            attempts: 5,
            recordedAttempts: 5,
            sends: 5,
          },
        ]}
      />,
    );

    expect(chartOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        xAxis: expect.objectContaining({ data: ["V1", "V4"] }),
        series: expect.arrayContaining([
          expect.objectContaining({ name: "Recorded attempts", data: [5, 3] }),
          expect.objectContaining({ name: "Sends", data: [5, 2] }),
        ]),
      }),
    );

    const option = chartOptions.mock.lastCall?.[0];
    setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 7 }) });
    for (const width of [360, 1100]) {
      const chart = init(null, null, { renderer: "svg", ssr: true, width, height: 280 });
      try {
        chart.setOption(option);
        const svg = new DOMParser().parseFromString(chart.renderToSVGString(), "image/svg+xml");
        const labels = Array.from(svg.querySelectorAll("text"), (node) => node.textContent);
        expect(labels).toEqual(expect.arrayContaining(["V1", "V4"]));
      } finally {
        chart.dispose();
      }
    }
  });

  it("plots recorded attempts when the complete total is unknown", () => {
    render(
      <ClimbingVolumeByGradeChart
        data={[
          {
            climbKind: "boulder",
            gradeSystem: "v_scale",
            grade: "VB",
            gradeSortValue: -1,
            attempts: null,
            recordedAttempts: 4,
            sends: 1,
          },
          {
            climbKind: "boulder",
            gradeSystem: "v_scale",
            grade: "V0",
            gradeSortValue: 0,
            attempts: null,
            recordedAttempts: 0,
            sends: 0,
          },
        ]}
      />,
    );

    expect(chartOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: expect.arrayContaining([
          expect.objectContaining({ name: "Recorded attempts", data: [4, 0] }),
          expect.objectContaining({ name: "Sends", data: [1, 0] }),
        ]),
      }),
    );
  });
});
