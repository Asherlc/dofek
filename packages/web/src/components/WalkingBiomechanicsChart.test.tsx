// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface ChartProps {
  empty?: boolean;
  emptyMessage?: string;
  option?: {
    series?: Array<{
      symbol?: string;
      symbolSize?: number;
    }>;
  };
}

const chartProps = vi.hoisted<ChartProps[]>(() => []);

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: (props: ChartProps) => {
    chartProps.push(props);
    return <div />;
  },
}));

import { WalkingBiomechanicsChart } from "./WalkingBiomechanicsChart.tsx";

afterEach(() => {
  cleanup();
  chartProps.length = 0;
});

function emptyStateByMessage(): Map<string | undefined, boolean | undefined> {
  return new Map(chartProps.map((props) => [props.emptyMessage, props.empty]));
}

describe("WalkingBiomechanicsChart", () => {
  it("renders an explicit empty state for each unavailable signal in a nonempty response", () => {
    render(
      <WalkingBiomechanicsChart
        data={[
          {
            date: "2026-07-28",
            walkingSpeedKmh: null,
            stepLengthCm: null,
            doubleSupportPct: null,
            asymmetryPct: null,
            steadiness: 0.92,
          },
        ]}
      />,
    );

    expect(emptyStateByMessage()).toEqual(
      new Map([
        ["No walking speed data available", true],
        ["No step length data available", true],
        ["No double support data available", true],
        ["No asymmetry data available", true],
      ]),
    );
  });

  it("renders available signals while marking only missing signals empty", () => {
    render(
      <WalkingBiomechanicsChart
        data={[
          {
            date: "2026-07-27",
            walkingSpeedKmh: null,
            stepLengthCm: null,
            doubleSupportPct: null,
            asymmetryPct: null,
            steadiness: 0.9,
          },
          {
            date: "2026-07-28",
            walkingSpeedKmh: 5.2,
            stepLengthCm: null,
            doubleSupportPct: null,
            asymmetryPct: 1.4,
            steadiness: 0.92,
          },
        ]}
      />,
    );

    expect(emptyStateByMessage()).toEqual(
      new Map([
        ["No walking speed data available", false],
        ["No step length data available", true],
        ["No double support data available", true],
        ["No asymmetry data available", false],
      ]),
    );
  });

  it("renders a marker when an available signal has only one observation", () => {
    render(
      <WalkingBiomechanicsChart
        data={[
          {
            date: "2026-07-27",
            walkingSpeedKmh: 5.2,
            stepLengthCm: null,
            doubleSupportPct: null,
            asymmetryPct: null,
            steadiness: 0.9,
          },
          {
            date: "2026-07-28",
            walkingSpeedKmh: null,
            stepLengthCm: null,
            doubleSupportPct: null,
            asymmetryPct: null,
            steadiness: 0.92,
          },
        ]}
      />,
    );

    expect(chartProps[0]?.empty).toBe(false);
    expect(chartProps[0]?.option?.series?.[0]).toMatchObject({
      symbol: "circle",
      symbolSize: 6,
    });
  });
});
