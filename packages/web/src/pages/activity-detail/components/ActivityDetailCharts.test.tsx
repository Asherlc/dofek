/** @vitest-environment jsdom */
import { formatDateTime, formatTimeOnly } from "@dofek/format/format";
import { UnitConverter } from "@dofek/format/units";
import { activityMetricSourcePreview } from "@dofek/training/fixtures/activity-metric-sources";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { init, setPlatformAPI } from "echarts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChartTable } from "../../../components/chart-accessibility.ts";
import {
  args,
  highlightClimbAnnotations,
  points,
  selectableClimbAnnotations,
  skinTemperaturePoints,
  timedClimbAnnotations,
  watchReadings,
  zoomClimbAnnotations,
} from "./ActivityDetailCharts.test-fixtures.ts";
import { MetricsChart } from "./ActivityDetailCharts.tsx";

const captured = vi.hoisted(() => {
  const option: Record<string, unknown> = {};
  const events: Record<string, (params: Record<string, unknown>) => void> = {};
  const replaceMerge: string[] = [];
  return { option, events, notMerge: true, renders: 0, replaceMerge };
});

vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    onEvents,
    notMerge,
    replaceMerge,
  }: {
    option: Record<string, unknown>;
    onEvents: typeof captured.events;
    notMerge: boolean;
    replaceMerge?: string[];
  }) => {
    captured.renders += 1;
    captured.option = option;
    captured.events = onEvents;
    captured.notMerge = notMerge;
    captured.replaceMerge = replaceMerge ?? [];
    return null;
  },
}));

it("keeps real legend, speed, time-tooltip and navigator options", () => {
  const units = new UnitConverter("imperial");
  const view = render(<MetricsChart {...args} activityType="cycling" units={units} />);
  const yAxes = captured.option.yAxis;
  if (!Array.isArray(yAxes)) throw new Error("Expected chart axes");
  const speedAxis = yAxes.find(
    (axis): axis is Record<string, unknown> =>
      typeof axis === "object" &&
      axis !== null &&
      String(Reflect.get(axis, "name")).includes("Speed"),
  );
  if (!speedAxis) throw new Error("Expected speed axis");
  expect(String(Reflect.get(speedAxis, "name"))).toContain(units.speedLabel);
  const cyclingCadence = yAxes.find(
    (axis): axis is Record<string, unknown> =>
      typeof axis === "object" &&
      axis !== null &&
      String(Reflect.get(axis, "name")).includes("Cadence"),
  );
  expect(cyclingCadence).toMatchObject({ name: "Cadence (rpm)" });

  const tooltip = captured.option.tooltip;
  if (typeof tooltip !== "object" || tooltip === null) throw new Error("Expected tooltip");
  const pointer = Reflect.get(tooltip, "axisPointer");
  if (typeof pointer !== "object" || pointer === null) throw new Error("Expected time pointer");
  const label = Reflect.get(pointer, "label");
  if (typeof label !== "object" || label === null) throw new Error("Expected pointer label");
  const formatter = Reflect.get(label, "formatter");
  if (typeof formatter !== "function") throw new Error("Expected time formatter");
  expect(formatter({ value: Date.parse(points[0].recordedAt) })).toBe(
    formatDateTime(new Date(points[0].recordedAt)),
  );

  const zoom = captured.option.dataZoom;
  if (!Array.isArray(zoom)) throw new Error("Expected chart navigator");
  const slider = zoom.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && Reflect.get(item, "type") === "slider",
  );
  if (!slider) throw new Error("Expected slider navigator");
  expect(slider).toMatchObject({
    showDataShadow: false,
    showDetail: true,
    height: 32,
    handleSize: "100%",
  });
  const labelFormatter = Reflect.get(slider, "labelFormatter");
  if (typeof labelFormatter !== "function") throw new Error("Expected navigator time labels");
  expect(labelFormatter(Date.parse(points[0].recordedAt))).toBe(
    formatTimeOnly(points[0].recordedAt),
  );

  act(() =>
    captured.events.legendselectchanged?.({
      selected: { "Heart Rate": false, Speed: true, ignored: "not-a-boolean" },
    }),
  );
  const legend = captured.option.legend;
  if (typeof legend !== "object" || legend === null) throw new Error("Expected legend options");
  expect(Reflect.get(legend, "selected")).toEqual({ "Heart Rate": false, Speed: true });
  view.rerender(<MetricsChart {...args} activityType="hiking" units={units} />);
  const hikingAxes = captured.option.yAxis;
  if (!Array.isArray(hikingAxes)) throw new Error("Expected hiking chart axes");
  const cadenceAxis = hikingAxes.find(
    (axis): axis is Record<string, unknown> =>
      typeof axis === "object" &&
      axis !== null &&
      String(Reflect.get(axis, "name")).includes("Cadence"),
  );
  expect(cadenceAxis).toMatchObject({ name: "Cadence (steps/min)" });
});

it("records drag zoom without rebuilding the metrics chart", () => {
  const view = render(<MetricsChart {...args} />);
  const renders = captured.renders;
  act(() => captured.events.datazoom?.({ start: 25, end: 75 }));
  expect(captured.renders).toBe(renders);
  view.rerender(<MetricsChart {...args} highlightedClimbId="first" />);
  const firstZoom = captured.option.dataZoom;
  if (!Array.isArray(firstZoom)) throw new Error("Expected data zoom controls");
  expect(firstZoom).toEqual(
    expect.arrayContaining([expect.objectContaining({ start: 25, end: 75 })]),
  );
});

it("selects annotation IDs from line and range clicks, including repeated names", () => {
  const onSelectClimb = vi.fn();
  render(
    <MetricsChart
      {...args}
      onSelectClimb={onSelectClimb}
      climbAnnotations={selectableClimbAnnotations}
    />,
  );
  const series = captured.option.series;
  if (!Array.isArray(series)) throw new Error("Expected series");
  act(() =>
    captured.events.click?.({ componentType: "markLine", data: series[0].markLine.data[1] }),
  );
  expect(onSelectClimb).toHaveBeenLastCalledWith("repeat");
  act(() =>
    captured.events.click?.({ componentType: "markArea", data: series[0].markArea.data[0][0] }),
  );
  expect(onSelectClimb).toHaveBeenLastCalledWith("range");
  onSelectClimb.mockClear();
  act(() => captured.events.click?.({ componentType: "series", data: series[0].data[0] }));
  expect(onSelectClimb).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Timed route/ }));
  expect(onSelectClimb).toHaveBeenLastCalledWith("range");
});

it("expands zoom only enough to reveal a selected climb and updates existing chart elements", () => {
  const view = render(<MetricsChart {...args} climbAnnotations={zoomClimbAnnotations} />);
  act(() => captured.events.datazoom?.({ start: 25, end: 75 }));
  view.rerender(
    <MetricsChart {...args} climbAnnotations={zoomClimbAnnotations} selectedClimbId="middle" />,
  );
  const middleZoom = captured.option.dataZoom;
  if (!Array.isArray(middleZoom)) throw new Error("Expected chart zoom controls");
  expect(middleZoom).toEqual(
    expect.arrayContaining([expect.objectContaining({ start: 25, end: 75 })]),
  );
  view.rerender(
    <MetricsChart {...args} climbAnnotations={zoomClimbAnnotations} selectedClimbId="first" />,
  );
  const rangeZoom = captured.option.dataZoom;
  if (!Array.isArray(rangeZoom)) throw new Error("Expected data zoom controls");
  expect(rangeZoom).toEqual(
    expect.arrayContaining([expect.objectContaining({ start: 0, end: 75 })]),
  );
  view.rerender(
    <MetricsChart {...args} climbAnnotations={zoomClimbAnnotations} selectedClimbId="range" />,
  );
  const dataZoom = captured.option.dataZoom;
  if (!Array.isArray(dataZoom)) throw new Error("Expected data zoom controls");
  expect(dataZoom).toEqual(
    expect.arrayContaining([expect.objectContaining({ start: 0, end: 100 })]),
  );
  expect(captured.notMerge).toBe(false);
  expect(captured.replaceMerge).toEqual(["series"]);
  const series = captured.option.series;
  if (!Array.isArray(series)) throw new Error("Expected series");
  expect(series[0].markLine.animation).toBe(false);
  expect(series[0].markArea.animation).toBe(false);
});

it("retains climbs at activity boundaries outside the HR sample range", () => {
  render(
    <MetricsChart
      {...args}
      activityWindow={{ startedAt: "2026-10-18T17:29:57Z", endedAt: "2026-10-18T17:31:05Z" }}
      climbAnnotations={[
        { id: "first", label: "First climb", startedAt: "2026-10-18T17:29:57Z", endedAt: null },
        { id: "last", label: "Last climb", startedAt: "2026-10-18T17:31:05Z", endedAt: null },
      ]}
    />,
  );
  expect(screen.getByText("Climbs (2)")).toBeDefined();
  expect(screen.getByText(/First climb/)).toBeDefined();
  expect(screen.getByText(/Last climb/)).toBeDefined();
  expect(captured.option.xAxis).toMatchObject({
    min: Date.parse("2026-10-18T17:29:57Z"),
    max: Date.parse("2026-10-18T17:31:05Z"),
  });
  const series = captured.option.series;
  if (!Array.isArray(series)) throw new Error("Expected chart series");
  expect(series[0].markLine.data).toHaveLength(2);
  expect(renderChartSvg().querySelectorAll('path[stroke="#a78bfa"]')).toHaveLength(2);
  expect(series[0].data.map((sample: { value: [number, number | null] }) => sample.value)).toEqual([
    [Date.parse(points[0].recordedAt), 140],
    [Date.parse("2026-10-18T17:30:30Z"), null],
    [Date.parse(points[1].recordedAt), 150],
  ]);
});

it("plots server-provided HR context without extending other metrics", () => {
  render(
    <MetricsChart
      {...args}
      highlightedClimbId="first"
      climbAnnotations={[
        { id: "first", label: "First climb", startedAt: "2026-10-18T17:30:00Z", endedAt: null },
        { id: "last", label: "Last climb", startedAt: "2026-10-18T17:31:00Z", endedAt: null },
      ]}
      heartRateContext={{
        window: { startedAt: "2026-10-18T17:25:00Z", endedAt: "2026-10-18T17:36:00Z" },
        points: [
          { recordedAt: "2026-10-18T17:25:00Z", value: 90 },
          { recordedAt: "2026-10-18T17:36:00Z", value: 100 },
        ],
      }}
    />,
  );
  expect(captured.option.xAxis).toMatchObject({
    min: Date.parse("2026-10-18T17:25:00Z"),
    max: Date.parse("2026-10-18T17:36:00Z"),
  });
  const series = captured.option.series;
  if (!Array.isArray(series)) throw new Error("Expected chart series");
  expect(series[0].markLine.data[0]).toMatchObject({
    name: "First climb",
    lineStyle: { width: 3, type: "solid" },
    label: { show: true },
  });
  expect(series[0].markLine.data[1].label.show).toBe(false);
  expect(series[0].data[0].value).toEqual([Date.parse("2026-10-18T17:25:00Z"), 90]);
  expect(series[0].data.at(-1).value).toEqual([Date.parse("2026-10-18T17:36:00Z"), 100]);
  expect(series[1].data[0].value).toEqual([Date.parse(points[0].recordedAt), 200]);
});

it("plots skin temperature at its own recorded times in the selected units", () => {
  const skinTemperatureMetric = activityMetricSourcePreview.find(
    (metric) => metric.key === "skinTemperature",
  );
  if (!skinTemperatureMetric) throw new Error("Expected skin temperature fixture");
  const selectedClimbAt = "2026-10-18T17:31:10Z";
  const chartProps = {
    ...args,
    points: skinTemperaturePoints,
    climbAnnotations: [
      {
        id: "late-temperature-window-climb",
        label: "Late climb",
        startedAt: selectedClimbAt,
        endedAt: null,
      },
      {
        id: "selected-climb",
        label: "Selected climb",
        startedAt: "2026-10-18T17:30:30Z",
        endedAt: null,
      },
    ],
    metricSources: [
      {
        key: "skinTemperature",
        label: "Skin Temperature",
        sources: skinTemperatureMetric.sources,
        selectedId: '["whoop_ble","strap-a"]',
        onChange: vi.fn(),
      },
    ],
    units: new UnitConverter("imperial"),
  };
  const view = render(<MetricsChart {...chartProps} />);
  act(() => captured.events.datazoom?.({ start: 0, end: 54 }));
  view.rerender(<MetricsChart {...chartProps} selectedClimbId="selected-climb" />);
  const series = captured.option.series;
  if (!Array.isArray(series)) throw new Error("Expected chart series");
  const temperature = series.find(
    (entry: { name: string; data?: unknown[] }) => entry.name === "Skin Temperature",
  );
  const temperatureData: unknown[] = Array.isArray(temperature?.data) ? temperature.data : [];
  const temperatureValues = temperatureData.flatMap((sample) => {
    if (typeof sample !== "object" || sample === null || !("value" in sample)) return [];
    const value = sample.value;
    if (
      !Array.isArray(value) ||
      typeof value[0] !== "number" ||
      (typeof value[1] !== "number" && value[1] !== null)
    ) {
      return [];
    }
    return [{ timestamp: value[0], value: value[1] }];
  });
  expect(temperatureValues.filter((sample) => sample.value !== null)).toEqual([
    { timestamp: Date.parse("2026-10-18T17:29:00Z"), value: 89.924 },
    { timestamp: Date.parse("2026-10-18T17:31:17Z"), value: 90.32 },
  ]);
  expect(temperatureValues.some((sample) => sample.value === null)).toBe(true);
  const xAxis = captured.option.xAxis;
  if (typeof xAxis !== "object" || xAxis === null) throw new Error("Expected time axis");
  expect(Reflect.get(xAxis, "min")).toBe(Date.parse("2026-10-18T17:29:00Z"));
  expect(Reflect.get(xAxis, "max")).toBe(Date.parse("2026-10-18T17:31:17Z"));
  const heartRate = series.find((entry: { name: string }) => entry.name === "Heart Rate");
  expect(heartRate?.markLine?.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "late-temperature-window-climb",
        xAxis: Date.parse(selectedClimbAt),
      }),
    ]),
  );
  const fallbackZoom = captured.option.dataZoom;
  if (!Array.isArray(fallbackZoom)) throw new Error("Expected chart zoom controls");
  expect(fallbackZoom[1]).toMatchObject({ start: 0, end: expect.closeTo(67.69, 1) });
  if (!Array.isArray(captured.option.yAxis)) throw new Error("Expected chart axes");
  const temperatureAxis = captured.option.yAxis.find(
    (axis: { name?: string; axisLabel?: { formatter?: (value: number) => string } }) =>
      axis.name === "Skin Temperature (°F)",
  );
  expect(temperatureAxis?.axisLabel?.formatter?.(89.924)).toBe("89.9");
  expect(temperature?.tooltip?.valueFormatter?.(89.924)).toBe("89.9");
  const heartRateSeries = series.find(
    (entry: { name: string; tooltip?: { valueFormatter?: (value: number) => string } }) =>
      entry.name === "Heart Rate",
  );
  expect(heartRateSeries?.tooltip?.valueFormatter?.(140)).toBe("140");
});

it("associates pending chart readings with the completed source beside the requested picker", () => {
  render(
    <MetricsChart
      {...args}
      metricSources={[
        {
          key: "power",
          label: "Power",
          sources: [
            {
              id: "wahoo",
              label: "Wahoo",
              presentation: {
                displayName: "Wahoo",
                providerId: "wahoo",
                sourceName: null,
                attribution: null,
              },
            },
            {
              id: "garmin",
              label: "Garmin",
              presentation: {
                displayName: "Garmin",
                providerId: "garmin",
                sourceName: null,
                attribution: null,
              },
            },
          ],
          selectedId: "garmin",
          onChange: vi.fn(),
        },
      ]}
      sourceAttribution={{ power: "Showing previous readings from Wahoo" }}
    />,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Showing previous readings from Wahoo");
  expect(screen.getByRole("button", { name: "Power source: Garmin" })).toBeInTheDocument();
});

it("keeps one decimal place for Celsius temperature labels and tooltips", () => {
  render(
    <MetricsChart
      {...args}
      points={[
        {
          ...points[0],
          skinTemperature: 32.18,
          skinTemperatureRecordedAt: "2026-10-18T17:30:17Z",
        },
      ]}
      metricSources={[
        {
          key: "skinTemperature",
          label: "Skin Temperature",
          sources: [],
          selectedId: '["whoop_ble","strap-a"]',
          onChange: vi.fn(),
        },
      ]}
      units={new UnitConverter("metric")}
    />,
  );
  if (!Array.isArray(captured.option.yAxis) || !Array.isArray(captured.option.series)) {
    throw new Error("Expected metric chart configuration");
  }
  const temperatureAxis = captured.option.yAxis.find(
    (axis: { name?: string; axisLabel?: { formatter?: (value: number) => string } }) =>
      axis.name === "Skin Temperature (°C)",
  );
  const temperatureSeries = captured.option.series.find(
    (entry: { name: string; tooltip?: { valueFormatter?: (value: number) => string } }) =>
      entry.name === "Skin Temperature",
  );
  expect(temperatureAxis?.axisLabel?.formatter?.(32.18)).toBe("32.2");
  expect(temperatureSeries?.tooltip?.valueFormatter?.(32.18)).toBe("32.2");
});

it.each([false, true])(
  "preserves user zoom while highlighting a climb (batched: %s)",
  (batched) => {
    const view = render(<MetricsChart {...args} />);
    setPlatformAPI({ measureText: (text) => ({ width: text.length * 7 }) });
    const chart = init(null, null, { renderer: "svg", ssr: true, width: 800, height: 380 });
    try {
      chart.setOption(captured.option);
      chart.on("datazoom", (event) => {
        if (typeof event === "object" && event !== null) captured.events.datazoom?.({ ...event });
      });
      act(() =>
        chart.dispatchAction(
          batched
            ? { type: "dataZoom", batch: [{ start: 25, end: 75 }] }
            : { type: "dataZoom", start: 25, end: 75 },
        ),
      );
      view.rerender(<MetricsChart {...args} highlightedClimbId="first" />);
      chart.setOption(captured.option, true);
      expect(chart.getOption().dataZoom).toEqual([
        expect.objectContaining({ start: 25, end: 75 }),
        expect.objectContaining({ start: 25, end: 75 }),
      ]);
    } finally {
      chart.dispose();
    }
  },
);

it("emphasizes only the active climb line or band and restores it on exit", () => {
  const view = render(
    <MetricsChart
      {...args}
      climbAnnotations={highlightClimbAnnotations}
      highlightedClimbId="repeat"
    />,
  );
  const hrSeries = () => {
    const series = captured.option.series;
    if (!Array.isArray(series)) throw new Error("Expected chart series");
    return series[0];
  };
  expect(hrSeries().markLine.data[1]).toMatchObject({
    lineStyle: { width: 3, type: "solid" },
    label: { show: true, formatter: "Repeat" },
  });
  expect(hrSeries().markLine.data[0].label.show).toBe(false);
  expect(renderChartSvg().documentElement.textContent).toContain("Repeat");
  view.rerender(
    <MetricsChart
      {...args}
      climbAnnotations={highlightClimbAnnotations}
      highlightedClimbId="range"
    />,
  );
  expect(hrSeries().markArea.data[0][0]).toMatchObject({
    itemStyle: { color: "rgba(167,139,250,0.36)" },
    label: { show: true, formatter: "Range" },
  });
  expect(hrSeries().markLine.data[1].lineStyle.width).toBe(1.5);
  expect(renderChartSvg().documentElement.textContent).toContain("Range");
  view.rerender(
    <MetricsChart
      {...args}
      climbAnnotations={highlightClimbAnnotations}
      highlightedClimbId={null}
    />,
  );
  expect(hrSeries().markArea.data[0][0].label.show).toBe(false);
  expect(hrSeries().markLine.data[1].label.show).toBe(false);
  view.rerender(
    <MetricsChart
      {...args}
      climbAnnotations={highlightClimbAnnotations}
      highlightedClimbId="no-timing"
    />,
  );
  expect(
    hrSeries().markLine.data.every((line: { label: { show: boolean } }) => !line.label.show),
  ).toBe(true);
});

it("overlays timed climbs on heart rate and exposes exact climb labels", () => {
  render(
    <MetricsChart {...args} activityType="climbing" climbAnnotations={timedClimbAnnotations} />,
  );
  const series = captured.option.series;
  if (!Array.isArray(series)) throw new Error("Expected chart series");
  expect(series[0].markLine.tooltip.trigger).toBe("item");
  expect(series[0].markArea.tooltip.trigger).toBe("item");
  expect(series[0].markLine.data).toEqual([
    expect.objectContaining({ name: "Corner · V3", xAxis: Date.parse("2026-10-18T17:30:20Z") }),
  ]);
  expect(series[0].markArea.data).toEqual([
    [
      expect.objectContaining({ name: "Arete · V4", xAxis: Date.parse(points[0].recordedAt) }),
      { xAxis: Date.parse("2026-10-18T17:30:40Z") },
    ],
  ]);
  expect(screen.getByText(/Corner · V3/)).toBeDefined();
  expect(screen.getByText(/Arete · V4/)).toBeDefined();
  expect(screen.queryByText(/Outside/)).toBeNull();
  const svg = renderChartSvg();
  expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
});

function customLegend({
  isVisible,
  toggle,
}: {
  isVisible: (name: string) => boolean;
  toggle: (name: string) => void;
}) {
  return (
    <fieldset aria-label="Metric controls">
      {["Heart Rate", "Power", "Speed", "Cadence"].map((name) => (
        <button
          key={name}
          type="button"
          aria-pressed={isVisible(name)}
          onClick={() => toggle(name)}
        >
          {name}
        </button>
      ))}
    </fieldset>
  );
}

function powerAxis() {
  const axes = captured.option.yAxis;
  if (!Array.isArray(axes)) throw new Error("Expected chart axes");
  return axes.find((axis) => axis.name === "Power (W)");
}

function renderChartSvg(action?: "highlight" | "downplay") {
  // Text measurement is the only browser canvas dependency of the real SVG renderer.
  setPlatformAPI({ measureText: (text) => ({ width: text.length * 7 }) });
  const chart = init(null, null, { renderer: "svg", ssr: true, width: 800, height: 380 });
  try {
    chart.setOption({ ...captured.option, animation: false });
    if (action) {
      chart.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex: 1 });
      chart.getZr().animation.update();
      if (action === "downplay") {
        chart.dispatchAction({ type: "downplay", seriesIndex: 0, dataIndex: 1 });
        chart.getZr().animation.update();
      }
    }
    return new DOMParser().parseFromString(chart.renderToSVGString(), "image/svg+xml");
  } finally {
    chart.dispose();
  }
}

function visibleChartSymbols(svg: Document) {
  const clip = svg
    .querySelector("clipPath path")
    ?.getAttribute("d")
    ?.match(/^M([\d.-]+) ([\d.-]+)l([\d.]+) 0l0 ([\d.]+)l-/);
  expect(clip).toBeTruthy();
  const left = Number(clip?.[1]);
  const top = Number(clip?.[2]);
  const right = left + Number(clip?.[3]);
  const bottom = top + Number(clip?.[4]);
  const symbols = Array.from(svg.querySelectorAll('[ecmeta_ssr_type="chart"]')).filter(
    (symbol) =>
      !symbol.getAttribute("transform")?.startsWith("matrix(0,0,0,0,") &&
      !symbol.getAttribute("transform")?.includes("NaN") &&
      symbol.getAttribute("fill-opacity") !== "0",
  );
  for (const symbol of symbols) {
    expect(symbol.getAttribute("d")).toMatch(/^M1 0A1 1 /);
    const matrix = symbol.getAttribute("transform")?.match(/^matrix\(([^)]+)\)$/);
    expect(matrix).toBeTruthy();
    const [scaleX = NaN, , , scaleY = NaN, centerX = NaN, centerY = NaN] =
      matrix?.[1]?.split(",").map(Number) ?? [];
    expect(scaleX).toBeGreaterThan(0);
    expect(scaleY).toBeGreaterThan(0);
    expect(centerX).toBeGreaterThanOrEqual(left);
    expect(centerX).toBeLessThanOrEqual(right);
    expect(centerY).toBeGreaterThanOrEqual(top);
    expect(centerY).toBeLessThanOrEqual(bottom);
  }
  return symbols;
}

describe("MetricsChart number formatting", () => {
  const fractionalPoints = points.map((point, index) => ({
    ...point,
    heartRate: index === 0 ? 43.383949279785156 : 76.92308044433594,
  }));

  function renderFractionalChart() {
    render(
      <MetricsChart
        {...args}
        points={fractionalPoints}
        hasPower={false}
        hasSpeed={false}
        hasCadence={false}
      />,
    );
  }

  it("renders fractional axis endpoints as whole numbers", () => {
    renderFractionalChart();

    const labels = Array.from(
      renderChartSvg().querySelectorAll("text"),
      (node) => node.textContent,
    );
    expect(labels).toContain("43");
    expect(labels).toContain("77");
  });

  it("rounds non-temperature tooltip values to whole numbers", () => {
    renderFractionalChart();

    const series = captured.option.series;
    if (!Array.isArray(series)) throw new Error("Expected chart series");
    const heartRate = series.find((entry) => entry.name === "Heart Rate");
    const tooltip = heartRate?.tooltip;
    if (typeof tooltip !== "object" || tooltip === null || !("valueFormatter" in tooltip)) {
      throw new Error("Expected heart-rate tooltip value formatter");
    }
    const formatter = tooltip.valueFormatter;
    if (typeof formatter !== "function") throw new Error("Expected tooltip value formatter");
    expect(formatter(43.383949279785156)).toBe("43");
    expect(formatter(76.92308044433594)).toBe("77");
    expect(formatter(0)).toBe("0");
  });

  it("rounds the accessible data values", () => {
    renderFractionalChart();

    const disclosure = screen.getByText("View chart data").closest("details");
    if (!(disclosure instanceof HTMLDetailsElement))
      throw new Error("Expected chart data disclosure");
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));

    expect(screen.getByRole("cell", { name: "43" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "77" })).toBeDefined();
  });
});

describe("MetricsChart sparse readings", () => {
  it("labels exact observations with readable timestamps in the chart data table", () => {
    render(<MetricsChart {...args} />);
    expect(buildChartTable(captured.option).rows).toContainEqual({
      series: "Heart Rate",
      category: `Sample 1 · ${formatDateTime(points[0].recordedAt)}`,
      value: "140",
    });
  });
  it("synchronizes map hover by timestamp rather than row number", () => {
    const onHoverPosition = vi.fn();
    render(
      <MetricsChart
        {...args}
        onHoverPosition={onHoverPosition}
        points={[0, 2, 20].map((second, index) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
          lat: 40 + index,
          lng: -70,
        }))}
      />,
    );
    captured.events.updateAxisPointer?.({
      axesInfo: [{ value: Date.UTC(2026, 9, 20, 16, 0, 6) }],
    });
    expect(onHoverPosition).toHaveBeenLastCalledWith({ lat: 41, lng: -70 });
    captured.events.globalout?.({});
    expect(onHoverPosition).toHaveBeenLastCalledWith(null);
  });

  it("connects regular HR readings across timestamps belonging to other metrics", () => {
    render(
      <MetricsChart
        {...args}
        hasPower={false}
        hasSpeed={false}
        hasCadence={false}
        points={[130, null, 135, null, 140].map((heartRate, index) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, index)).toISOString(),
          heartRate,
        }))}
      />,
    );

    const line = renderChartSvg().querySelector('path[stroke-width="1.5"]');
    expect(line?.getAttribute("d")?.match(/[ML]/g)).toEqual(["M", "L", "L"]);
  });

  it("spaces readings proportionally to elapsed time", () => {
    render(
      <MetricsChart
        {...args}
        hasPower={false}
        hasSpeed={false}
        hasCadence={false}
        points={[0, 1, 4].map((second) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
        }))}
      />,
    );

    const svg = renderChartSvg("highlight");
    const marker = visibleChartSymbols(svg).find(
      (symbol) => symbol.getAttribute("ecmeta_data_index") === "1",
    );
    const coordinates = marker?.getAttribute("transform")?.match(/^matrix\(([^)]+)\)$/)?.[1];
    const centerX = Number(coordinates?.split(",")[4]);
    // The plot runs from x=60 to x=740; one second is a quarter of four seconds.
    expect(centerX).toBeCloseTo(230, 0);
  });

  it("breaks the line at a long HR interruption even without intervening rows", () => {
    render(
      <MetricsChart
        {...args}
        hasPower={false}
        hasSpeed={false}
        hasCadence={false}
        points={[0, 1, 2, 20, 21].map((second) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
        }))}
      />,
    );

    const line = renderChartSvg().querySelector('path[stroke-width="1.5"]');
    expect(line?.getAttribute("d")?.match(/[ML]/g)).toEqual(["M", "L", "L", "M", "L"]);
  });

  it("renders every sparse Watch reading among a dense activity timeline", () => {
    render(
      <MetricsChart
        {...args}
        points={Array.from({ length: 490 }, (_, index) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 3, index)).toISOString(),
          heartRate: watchReadings.get(index) ?? null,
          power: 200,
          speed: 8,
          cadence: 80,
          altitude: null,
          lat: null,
          lng: null,
        }))}
      />,
    );

    const svg = renderChartSvg();
    const series = captured.option.series;
    if (!Array.isArray(series)) throw new Error("Expected chart series");
    expect(
      visibleChartSymbols(svg)
        .filter((symbol) => symbol.getAttribute("ecmeta_series_index") === "0")
        .map((symbol) => series[0].data[Number(symbol.getAttribute("ecmeta_data_index"))].value),
    ).toEqual(
      [...watchReadings].map(([second, value]) => [Date.UTC(2026, 9, 20, 16, 3, second), value]),
    );
  });

  it.each([
    { values: [0], minute: 0 },
    { values: [null, 0, null], minute: 1 },
  ])("renders a single zero reading as a dot: $values", ({ values, minute }) => {
    render(
      <MetricsChart
        {...args}
        hasHr={false}
        hasSpeed={false}
        hasCadence={false}
        points={values.map((power, index) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, index)).toISOString(),
          heartRate: null,
          power,
          speed: null,
          cadence: null,
          altitude: null,
          lat: null,
          lng: null,
        }))}
      />,
    );

    const svg = renderChartSvg();
    const symbols = visibleChartSymbols(svg);
    expect(symbols).toHaveLength(1);
    const series = captured.option.series;
    if (!Array.isArray(series)) throw new Error("Expected chart series");
    expect(series[0].data[0].value).toEqual([Date.UTC(2026, 9, 20, 16, minute), 0]);
  });

  it("keeps sparse readings visible and preserves recording gaps", () => {
    render(
      <MetricsChart
        {...args}
        hasPower={false}
        hasSpeed={false}
        hasCadence={false}
        points={[130, 135, null, 145, 150].map((heartRate, index) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, index)).toISOString(),
          heartRate,
          power: null,
          speed: null,
          cadence: null,
          altitude: null,
          lat: null,
          lng: null,
        }))}
      />,
    );

    const svg = renderChartSvg();
    const line = svg.querySelector('path[stroke-width="1.5"]');
    expect(line?.getAttribute("d")?.match(/[ML]/g)).toEqual(["M", "L", "M", "L"]);
    expect(visibleChartSymbols(svg)).toHaveLength(4);
  });

  it("shows a continuous reading on hover and hides its marker afterward", () => {
    render(
      <MetricsChart
        {...args}
        hasPower={false}
        hasSpeed={false}
        hasCadence={false}
        points={Array.from({ length: 40 }, (_, index) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, index)).toISOString(),
          heartRate: 130 + index,
          power: null,
          speed: null,
          cadence: null,
          altitude: null,
          lat: null,
          lng: null,
        }))}
      />,
    );

    expect(visibleChartSymbols(renderChartSvg())).toHaveLength(0);
    const highlighted = renderChartSvg("highlight");
    expect(highlighted.documentElement.outerHTML).not.toContain("NaN");
    const marker = visibleChartSymbols(highlighted)[0];
    const transform = marker?.getAttribute("transform") ?? "";
    const scale = transform.startsWith("matrix(") ? Number(transform.slice(7).split(",")[0]) : 1;
    expect(scale).toBeGreaterThanOrEqual(3);
    expect(
      visibleChartSymbols(highlighted).map((symbol) => symbol.getAttribute("ecmeta_data_index")),
    ).toEqual(["1"]);
    expect(visibleChartSymbols(renderChartSvg("downplay"))).toHaveLength(0);
  });
});

describe("MetricsChart custom legend", () => {
  beforeEach(() => {
    captured.option = {};
  });

  it("keeps the visibility toggle independent from the source chooser", () => {
    const onChange = vi.fn();
    render(
      <MetricsChart
        {...args}
        metricSources={[
          {
            key: "power",
            label: "Power",
            sources: [
              {
                id: "wahoo",
                label: "Wahoo",
                presentation: {
                  displayName: "Wahoo",
                  providerId: "wahoo",
                  sourceName: null,
                  attribution: { kind: "cloud", label: "via Wahoo" },
                },
              },
              {
                id: "garmin",
                label: "Garmin",
                presentation: {
                  displayName: "Garmin",
                  providerId: "garmin",
                  sourceName: null,
                  attribution: { kind: "cloud", label: "via Garmin" },
                },
              },
            ],
            selectedId: "wahoo",
            onChange,
          },
        ]}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Toggle Power" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Power source: Wahoo" }));
    fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
    expect(onChange).toHaveBeenCalledWith("garmin");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(powerAxis()).toMatchObject({ show: false });
  });

  it("toggles one metric and its axis through the custom legend", () => {
    render(<MetricsChart {...args} renderLegend={customLegend} />);
    const power = screen.getByRole("button", { name: "Power" });
    expect(power.getAttribute("aria-pressed")).toBe("true");
    expect(captured.option.legend).toMatchObject({ show: false });
    expect(powerAxis()).toMatchObject({ show: true });

    fireEvent.click(power);

    expect(power.getAttribute("aria-pressed")).toBe("false");
    expect(captured.option.legend).toMatchObject({ selected: { Power: false } });
    expect(powerAxis()).toMatchObject({ show: false });
    expect(screen.getByRole("button", { name: "Heart Rate" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(power);
    expect(power.getAttribute("aria-pressed")).toBe("true");
    expect(powerAxis()).toMatchObject({ show: true });
  });

  it("places titles beside multiple right-hand axes and restores a lone horizontal title", () => {
    render(
      <MetricsChart
        {...args}
        points={skinTemperaturePoints}
        metricSources={[
          {
            key: "skinTemperature",
            label: "Skin Temperature",
            sources: [],
            selectedId: '["whoop_ble","strap-a"]',
            onChange: vi.fn(),
          },
        ]}
      />,
    );

    const verticalTitle = { nameLocation: "middle", nameRotate: 90, nameGap: 43 };
    const horizontalTitle = { nameLocation: "end", nameRotate: 0, nameGap: 15 };
    expect(captured.option.yAxis).toMatchObject([
      { name: "Heart Rate (bpm)", position: "left", ...horizontalTitle },
      { name: "Power (W)", offset: 0, ...verticalTitle },
      { name: "Speed (km/h)", offset: 60, ...verticalTitle },
      { name: "Cadence (rpm)", offset: 120, ...verticalTitle },
      { name: "Skin Temperature (°C)", offset: 180, ...verticalTitle },
    ]);

    for (const name of ["Toggle Power", "Toggle Speed", "Toggle Cadence"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(captured.option.yAxis).toMatchObject([
      { name: "Heart Rate (bpm)", show: true, ...horizontalTitle },
      { show: false },
      { show: false },
      { show: false },
      { name: "Skin Temperature (°C)", show: true, offset: 0, ...horizontalTitle },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Toggle Power" }));
    expect(captured.option.yAxis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Power (W)", offset: 0, ...verticalTitle }),
        expect.objectContaining({ name: "Skin Temperature (°C)", offset: 60, ...verticalTitle }),
      ]),
    );
  });

  it("preserves metric visibility when source data changes", () => {
    const chart = render(<MetricsChart {...args} renderLegend={customLegend} />);
    fireEvent.click(screen.getByRole("button", { name: "Power" }));

    chart.rerender(
      <MetricsChart
        {...args}
        points={points.map((point) => ({ ...point, heartRate: 160 }))}
        renderLegend={customLegend}
      />,
    );

    expect(screen.getByRole("button", { name: "Power" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(powerAxis()).toMatchObject({ show: false });
    const series = captured.option.series;
    if (!Array.isArray(series)) throw new Error("Expected chart series");
    expect(series.find((item) => item.name === "Heart Rate")?.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: [Date.parse(points[0].recordedAt), 160] }),
        expect.objectContaining({ value: [Date.parse(points[1].recordedAt), 160] }),
      ]),
    );
    expect(series.find((item) => item.name === "Power")?.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: [Date.parse(points[0].recordedAt), 200] }),
        expect.objectContaining({ value: [Date.parse(points[1].recordedAt), 220] }),
      ]),
    );
  });
});
