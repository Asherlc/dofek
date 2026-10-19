/** @vitest-environment jsdom */
import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(series.find((item) => item.name === "Heart Rate")).toMatchObject({ data: [160, 160] });
    expect(series.find((item) => item.name === "Power")).toMatchObject({ data: [200, 220] });
  });
});
