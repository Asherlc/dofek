// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { render } from "@testing-library/react";
import { init, setPlatformAPI } from "echarts";
import { beforeEach, expect, it, vi } from "vitest";
import type { StreamPoint } from "../../../../../server/src/routers/activity.ts";

const captured = vi.hoisted(() => {
  const state: {
    option?: Record<string, unknown>;
    events?: Record<string, (params: Record<string, unknown>) => void>;
  } = {};
  return state;
});
vi.mock("echarts-for-react", () => ({
  default: (props: {
    option: Record<string, unknown>;
    onEvents?: Record<string, (params: Record<string, unknown>) => void>;
  }) => {
    captured.option = props.option;
    captured.events = props.onEvents ?? {};
    return <div data-testid="chart" />;
  },
}));

import { ElevationChart } from "./ElevationChart.tsx";

beforeEach(() => {
  delete captured.option;
  delete captured.events;
});

const points: StreamPoint[] = [0, 1, 2, 20].map((second) => ({
  recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
  altitude: 200 + second,
  heartRate: null,
  power: null,
  speed: null,
  cadence: null,
  lat: null,
  lng: null,
}));

it("uses the selected elevation units for axes, observations and tooltips", () => {
  render(<ElevationChart points={points} loading={false} units={new UnitConverter("imperial")} />);
  const option = captured.option;
  if (!option) throw new Error("Expected elevation chart option");
  const firstPoint = points[0];
  if (!firstPoint) throw new Error("Expected elevation point");
  const yAxis = option.yAxis;
  if (typeof yAxis !== "object" || yAxis === null) throw new Error("Expected elevation axis");
  expect(Reflect.get(yAxis, "name")).toContain("ft");
  const series = Reflect.get(option, "series");
  if (!Array.isArray(series) || typeof series[0] !== "object" || series[0] === null)
    throw new Error("Expected elevation series");
  const data = Reflect.get(series[0], "data");
  if (!Array.isArray(data)) throw new Error("Expected elevation samples");
  const firstSample = data[0];
  if (typeof firstSample !== "object" || firstSample === null)
    throw new Error("Expected first sample");
  const firstValue = Reflect.get(firstSample, "value");
  if (!Array.isArray(firstValue)) throw new Error("Expected first sample value");
  expect(firstValue[1]).toBe(656);
  expect(
    data.some((sample) => {
      if (typeof sample !== "object" || sample === null) return false;
      const value = Reflect.get(sample, "value");
      return Array.isArray(value) && value[1] === null;
    }),
  ).toBe(true);
  const tooltip = option.tooltip;
  if (typeof tooltip !== "object" || tooltip === null)
    throw new Error("Expected elevation tooltip");
  const formatter = Reflect.get(tooltip, "formatter");
  if (typeof formatter !== "function") throw new Error("Expected elevation tooltip formatter");
  expect(formatter([{ value: [Date.parse(firstPoint.recordedAt), 656] }])).toContain("ft");
});

it.each([
  { unitSystem: "metric", lowerBound: 2300, upperBound: 2600 },
  { unitSystem: "imperial", lowerBound: 7500, upperBound: 8500 },
] as const)(
  "fits the elevation axis to 2400-meter observations in $unitSystem units",
  ({ unitSystem, lowerBound, upperBound }) => {
    const highPoints = points.map((point, index) => ({ ...point, altitude: 2400 + index * 50 }));
    render(
      <ElevationChart points={highPoints} loading={false} units={new UnitConverter(unitSystem)} />,
    );
    const option = captured.option;
    if (!option) throw new Error("Expected elevation chart option");
    setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 7 }) });
    const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const chart = init(null, null, { renderer: "svg", ssr: true, width: 600, height: 200 });
    try {
      chart.setOption(option);
      expect(chart.convertFromPixel({ yAxisIndex: 0 }, 170)).toBeGreaterThan(lowerBound);
      expect(chart.convertFromPixel({ yAxisIndex: 0 }, 10)).toBeLessThan(upperBound);
    } finally {
      chart.dispose();
      canvasContext.mockRestore();
    }
  },
);

it("retains meter values and the meter axis label in metric units", () => {
  const metricPoints = points.map((point, index) => ({ ...point, altitude: 100 + index * 10 }));
  render(
    <ElevationChart points={metricPoints} loading={false} units={new UnitConverter("metric")} />,
  );
  const option = captured.option;
  if (!option) throw new Error("Expected elevation chart option");
  const axis = option.yAxis;
  if (typeof axis !== "object" || axis === null) throw new Error("Expected metric axis");
  expect(Reflect.get(axis, "name")).toContain("m");
  const series = option.series;
  if (!Array.isArray(series) || typeof series[0] !== "object" || series[0] === null)
    throw new Error("Expected elevation series");
  const data = Reflect.get(series[0], "data");
  if (!Array.isArray(data)) throw new Error("Expected metric samples");
  const first = data[0];
  if (typeof first !== "object" || first === null) throw new Error("Expected first metric sample");
  const value = Reflect.get(first, "value");
  if (!Array.isArray(value)) throw new Error("Expected metric sample value");
  expect(value[1]).toBe(100);
});

it("maps chart hover timestamps to their recorded GPS point", () => {
  const onHoverPosition = vi.fn();
  render(
    <ElevationChart
      points={points.map((point, index) => ({ ...point, lat: 40 + index, lng: -70 }))}
      loading={false}
      units={new UnitConverter("metric")}
      onHoverPosition={onHoverPosition}
    />,
  );
  const secondPoint = points[1];
  if (!secondPoint) throw new Error("Expected second elevation point");
  captured.events?.updateAxisPointer?.({
    axesInfo: [{ value: Date.parse(secondPoint.recordedAt) }],
  });
  expect(onHoverPosition).toHaveBeenLastCalledWith({ lat: 41, lng: -70 });
  captured.events?.globalout?.({});
  expect(onHoverPosition).toHaveBeenLastCalledWith(null);
});

it("retains the tooltip for the first elevation observation after a gap", () => {
  const resumedAt = Date.UTC(2026, 9, 20, 16, 0, 20);
  const basePoint = points[0];
  if (!basePoint) throw new Error("Expected base elevation point");
  render(
    <ElevationChart
      loading={false}
      units={new UnitConverter("metric")}
      points={[0, 1, 2, 20, 21].map((second) => ({
        ...basePoint,
        recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
        altitude: 200 + second,
      }))}
    />,
  );
  setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 7 }) });
  const chart = init(null, null, { renderer: "svg", ssr: true, width: 800, height: 380 });
  try {
    const capturedOption = captured.option;
    if (!capturedOption) throw new Error("Expected chart option");
    chart.setOption({ ...capturedOption, animation: false });
    const selected: { dataIndex: number | null } = { dataIndex: null };
    chart.on("updateAxisPointer", (event: unknown) => {
      if (
        typeof event === "object" &&
        event !== null &&
        "dataIndex" in event &&
        typeof event.dataIndex === "number"
      ) {
        selected.dataIndex = event.dataIndex;
      }
    });
    const pixelX = chart.convertToPixel({ xAxisIndex: 0 }, resumedAt);
    if (typeof pixelX !== "number") throw new Error("Expected time-axis pixel");
    chart.dispatchAction({ type: "updateAxisPointer", x: pixelX, y: 100 });
    const option = captured.option;
    if (!option) throw new Error("Expected chart option");
    const series = option.series;
    if (!Array.isArray(series) || selected.dataIndex === null)
      throw new Error("Expected selected observation");
    const line = series[0];
    if (typeof line !== "object" || line === null) throw new Error("Expected elevation line");
    const data = Reflect.get(line, "data");
    if (!Array.isArray(data)) throw new Error("Expected elevation data");
    const observation = data[selected.dataIndex];
    if (typeof observation !== "object" || observation === null)
      throw new Error("Expected observation");
    expect(Reflect.get(observation, "value")).toEqual([resumedAt, 220]);
    const tooltip = option.tooltip;
    if (typeof tooltip !== "object" || tooltip === null)
      throw new Error("Expected elevation tooltip");
    const formatter = Reflect.get(tooltip, "formatter");
    if (typeof formatter !== "function") throw new Error("Expected tooltip formatter");
    expect(formatter([observation])).toContain("Elevation: 220 m");
  } finally {
    chart.dispose();
  }
});
