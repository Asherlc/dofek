/** @vitest-environment jsdom */
import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
import { init, setPlatformAPI } from "echarts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsChart } from "./ActivityDetailCharts.tsx";

const captured = vi.hoisted(() => {
  const option: Record<string, unknown> = {};
  return { option };
});

vi.mock("echarts-for-react", () => ({
  default: ({ option }: { option: Record<string, unknown> }) => {
    captured.option = option;
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
];

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
  return Array.from(svg.querySelectorAll('[ecmeta_ssr_type="chart"]')).filter(
    (symbol) =>
      !symbol.getAttribute("transform")?.startsWith("matrix(0,0,0,0,") &&
      !symbol.getAttribute("transform")?.includes("NaN") &&
      symbol.getAttribute("fill-opacity") !== "0",
  );
}

describe("MetricsChart sparse readings", () => {
  it("renders every isolated Watch reading among a dense activity timeline", () => {
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
    expect(
      visibleChartSymbols(svg)
        .filter((symbol) => symbol.getAttribute("ecmeta_series_index") === "0")
        .map((symbol) => symbol.getAttribute("ecmeta_data_index")),
    ).toEqual([
      "7",
      "67",
      "97",
      "154",
      "186",
      "223",
      "252",
      "297",
      "314",
      "335",
      "376",
      "396",
      "464",
    ]);
  });

  it.each([
    { values: [0], symbolIndex: "0" },
    { values: [null, 0, null], symbolIndex: "1" },
  ])("renders a single zero reading as a dot: $values", ({ values, symbolIndex }) => {
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
    expect(symbols[0]?.getAttribute("ecmeta_data_index")).toBe(symbolIndex);
  });

  it("keeps continuous readings as lines and preserves missing-sample gaps", () => {
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
    expect(visibleChartSymbols(svg)).toHaveLength(0);
  });

  it("shows a continuous reading on hover and hides its marker afterward", () => {
    render(
      <MetricsChart
        {...args}
        hasPower={false}
        hasSpeed={false}
        hasCadence={false}
        points={[130, 140, 150].map((heartRate, index) => ({
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
    expect(series.find((item) => item.name === "Heart Rate")).toMatchObject({
      data: [{ value: 160 }, { value: 160 }],
    });
    expect(series.find((item) => item.name === "Power")).toMatchObject({
      data: [{ value: 200 }, { value: 220 }],
    });
  });
});
