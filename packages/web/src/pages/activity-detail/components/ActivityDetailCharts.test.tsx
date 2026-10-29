/** @vitest-environment jsdom */
import { formatDateTime } from "@dofek/format/format";
import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
import { init, setPlatformAPI } from "echarts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamPoint } from "../../../../../server/src/routers/activity.ts";
import { buildChartTable } from "../../../components/chart-accessibility.ts";
import { ElevationChart, MetricsChart } from "./ActivityDetailCharts.tsx";

const captured = vi.hoisted(() => {
  const option: Record<string, unknown> = {};
  const events: Record<string, (params: Record<string, unknown>) => void> = {};
  return { option, events };
});

vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    onEvents,
  }: {
    option: Record<string, unknown>;
    onEvents: typeof captured.events;
  }) => {
    captured.option = option;
    captured.events = onEvents;
    return null;
  },
}));

const points = [
  {
    recordedAt: "2026-10-18T17:30:00Z",
    heartRate: 140,
    power: 200,
    speed: 8,
    cadence: 80,
    altitude: 200,
    lat: null,
    lng: null,
  },
  {
    recordedAt: "2026-10-18T17:31:00Z",
    heartRate: 150,
    power: 220,
    speed: 9,
    cadence: 85,
    altitude: 205,
    lat: null,
    lng: null,
  },
] satisfies [StreamPoint, StreamPoint];

const args = {
  points,
  activityType: "cycling",
  hasHr: true,
  hasPower: true,
  hasSpeed: true,
  hasCadence: true,
  loading: false,
  units: new UnitConverter("metric"),
};

it("overlays timed climbs on heart rate and exposes exact climb labels", () => {
  render(
    <MetricsChart
      {...args}
      activityType="climbing"
      climbAnnotations={[
        { id: "ascent", label: "Corner · V3", startedAt: "2026-10-18T17:30:20Z", endedAt: null },
        {
          id: "range",
          label: "Arete · V4",
          startedAt: "2026-10-18T17:29:00Z",
          endedAt: "2026-10-18T17:30:40Z",
        },
        { id: "outside", label: "Outside", startedAt: "2026-10-18T17:32:00Z", endedAt: null },
      ]}
    />,
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

  it("rounds tooltip values to whole numbers", () => {
    renderFractionalChart();

    const tooltip = captured.option.tooltip;
    if (typeof tooltip !== "object" || tooltip === null || !("valueFormatter" in tooltip)) {
      throw new Error("Expected tooltip value formatter");
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
  it("retains the tooltip of an elevation observation immediately after a gap", () => {
    const resumedAt = Date.UTC(2026, 9, 20, 16, 0, 20);
    render(
      <ElevationChart
        loading={false}
        units={args.units}
        points={[0, 1, 2, 20, 21].map((second) => ({
          ...points[0],
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
          altitude: 200 + second,
        }))}
      />,
    );
    setPlatformAPI({ measureText: (text) => ({ width: String(text).length * 7 }) });
    const chart = init(null, null, { renderer: "svg", ssr: true, width: 800, height: 380 });
    try {
      chart.setOption({ ...captured.option, animation: false });
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
      const series = captured.option.series;
      if (!Array.isArray(series) || selected.dataIndex === null)
        throw new Error("Expected selected observation");
      const observation = series[0].data[selected.dataIndex];
      expect(observation.value).toEqual([resumedAt, 220]);
      const tooltip = captured.option.tooltip;
      if (!tooltip || typeof tooltip !== "object") throw new Error("Expected elevation tooltip");
      const formatter = Reflect.get(tooltip, "formatter");
      expect(formatter([observation])).toContain("Elevation: 220 m");
    } finally {
      chart.dispose();
    }
  });

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
    const watchReadings = new Map([
      [7, 80],
      [67, 100],
      [97, 110],
      [154, 120],
      [186, 125],
      [223, 130],
      [252, 135],
      [297, 140],
      [314, 145],
      [335, 150],
      [376, 155],
      [396, 120],
      [464, 100],
    ]);
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
