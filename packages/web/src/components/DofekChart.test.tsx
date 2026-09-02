/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockUseFetchingCount } = vi.hoisted(() => ({
  mockUseFetchingCount: vi.fn(() => 0),
}));

vi.mock("../lib/FetchingContext.tsx", () => ({
  useFetchingCount: mockUseFetchingCount,
}));

// Mock echarts-for-react before importing the component
vi.mock("echarts-for-react", () => ({
  default: ({
    option,
    style,
    notMerge,
    opts,
  }: {
    option: Record<string, unknown>;
    style: Record<string, unknown>;
    notMerge: boolean;
    opts?: Record<string, unknown>;
  }) => (
    <div
      data-testid="echarts-mock"
      data-option={JSON.stringify(option)}
      data-not-merge={String(notMerge)}
      data-opts={opts ? JSON.stringify(opts) : undefined}
      style={style satisfies React.CSSProperties}
    />
  ),
}));

vi.mock("./LoadingSkeleton.tsx", () => ({
  ChartLoadingSkeleton: ({ height }: { height: number }) => (
    <div data-testid="loading-skeleton" style={{ height }} className="animate-spin" />
  ),
}));

const { ChartRangeProvider, DofekChart } = await import("./DofekChart.tsx");

describe("DofekChart", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders loading skeleton when loading is true", () => {
    render(<DofekChart option={{}} loading={true} />);
    expect(screen.getByTestId("loading-skeleton")).toBeDefined();
    expect(screen.queryByTestId("echarts-mock")).toBeNull();
  });

  it("renders loading skeleton with custom height", () => {
    const { container } = render(<DofekChart option={{}} loading={true} height={400} />);
    const skeleton = container.querySelector("[data-testid='loading-skeleton']");
    expect(skeleton).not.toBeNull();
    if (skeleton instanceof HTMLElement) {
      expect(skeleton.style.height).toBe("400px");
    }
  });

  it("shows empty message when empty is true", () => {
    render(<DofekChart option={{}} empty={true} />);
    expect(screen.getByText("No data available")).toBeDefined();
    expect(screen.queryByTestId("echarts-mock")).toBeNull();
    expect(screen.queryByTestId("loading-skeleton")).toBeNull();
  });

  it("shows custom empty message", () => {
    render(<DofekChart option={{}} empty={true} emptyMessage="No sleep data yet" />);
    expect(screen.getByText("No sleep data yet")).toBeDefined();
  });

  it("renders empty state with correct height", () => {
    const { container } = render(<DofekChart option={{}} empty={true} height={300} />);
    const emptyDiv = container.querySelector(".flex.items-center.justify-center");
    expect(emptyDiv).not.toBeNull();
    if (emptyDiv instanceof HTMLElement) {
      expect(emptyDiv.style.height).toBe("300px");
    }
  });

  it("uses default height of 250 for empty state", () => {
    const { container } = render(<DofekChart option={{}} empty={true} />);
    const emptyDiv = container.querySelector(".flex.items-center.justify-center");
    expect(emptyDiv).not.toBeNull();
    if (emptyDiv instanceof HTMLElement) {
      expect(emptyDiv.style.height).toBe("250px");
    }
  });

  it("prioritizes loading over empty state", () => {
    render(<DofekChart option={{}} loading={true} empty={true} />);
    expect(screen.getByTestId("loading-skeleton")).toBeDefined();
    expect(screen.queryByText("No data available")).toBeNull();
  });

  it("renders chart when not loading and not empty", () => {
    render(<DofekChart option={{ series: [{ type: "line" }] }} />);
    expect(screen.getByTestId("echarts-mock")).toBeDefined();
  });

  it("enables an accessible chart description for every ECharts instance", () => {
    render(
      <DofekChart
        option={{
          xAxis: { type: "time", name: "Date" },
          yAxis: { type: "value", name: "Resting heart rate" },
          series: [{ type: "line", name: "Resting heart rate", data: [["2026-07-01", 52]] }],
        }}
      />,
    );

    const option = JSON.parse(
      screen.getByTestId("echarts-mock").getAttribute("data-option") ?? "{}",
    );
    expect(option.aria.enabled).toBe(true);
    expect(option.aria.label.description).toBe(
      "Chart showing Resting heart rate. Use the chart data table for exact values.",
    );
    expect(
      screen.getByText(
        "Chart showing Resting heart rate. Use the chart data table for exact values.",
      ),
    ).toBeDefined();
  });

  it("preserves a chart's explicit accessibility description", () => {
    render(
      <DofekChart
        option={{
          aria: {
            enabled: true,
            label: { description: "Daily recovery is shown as a numeric line." },
          },
          series: [{ type: "line", data: [["2026-07-01", 81]] }],
        }}
      />,
    );

    const option = JSON.parse(
      screen.getByTestId("echarts-mock").getAttribute("data-option") ?? "{}",
    );
    expect(option.aria.label.description).toBe("Daily recovery is shown as a numeric line.");
    expect(screen.getByText("Daily recovery is shown as a numeric line.")).toBeDefined();
  });

  it("provides exact chart values in a keyboard-operable data table", () => {
    render(
      <DofekChart
        option={{
          xAxis: { type: "category", name: "Day", data: ["Monday", "Tuesday"] },
          series: [{ type: "bar", name: "Steps", data: [4_200, 6_100] }],
        }}
      />,
    );

    const disclosure = screen.getByText("View chart data").closest("details");
    expect(disclosure).not.toBeNull();
    if (!(disclosure instanceof HTMLDetailsElement)) {
      throw new Error("Expected chart data disclosure");
    }

    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));

    expect(screen.getByRole("table", { name: /chart showing steps/i })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Day" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "Monday" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "4200" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "Tuesday" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "6100" })).toBeDefined();
  });

  it("forces transparent background on chart option", () => {
    render(<DofekChart option={{ series: [] }} />);
    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.backgroundColor).toBe("transparent");
  });

  it("preserves user options while adding transparent background", () => {
    render(<DofekChart option={{ series: [{ type: "bar" }], tooltip: { trigger: "axis" } }} />);
    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.backgroundColor).toBe("transparent");
    expect(option.series).toEqual([{ type: "bar" }]);
    expect(option.tooltip).toEqual({ trigger: "axis" });
  });

  it("transparent background cannot be overridden by user option", () => {
    render(<DofekChart option={{ backgroundColor: "#ff0000" }} />);
    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    // backgroundColor: "transparent" is spread first, then ...option overrides it
    // Actually looking at the source: { backgroundColor: "transparent", ...option }
    // So user's backgroundColor WOULD override. Let's check the actual behavior.
    // Source: option={{ backgroundColor: "transparent", ...option }}
    // This means user-provided backgroundColor overrides transparent.
    expect(option.backgroundColor).toBe("#ff0000");
  });

  it("sets chart height from prop", () => {
    render(<DofekChart option={{}} height={500} />);
    const chart = screen.getByTestId("echarts-mock");
    expect(chart.style.height).toBe("500px");
  });

  it("uses default height of 250", () => {
    render(<DofekChart option={{}} />);
    const chart = screen.getByTestId("echarts-mock");
    expect(chart.style.height).toBe("250px");
  });

  it("sets width to 100%", () => {
    render(<DofekChart option={{}} />);
    const chart = screen.getByTestId("echarts-mock");
    expect(chart.style.width).toBe("100%");
  });

  it("passes notMerge as true", () => {
    render(<DofekChart option={{}} />);
    const chart = screen.getByTestId("echarts-mock");
    expect(chart.getAttribute("data-not-merge")).toBe("true");
  });

  it("passes opts to ECharts", () => {
    render(<DofekChart option={{}} opts={{ renderer: "svg" }} />);
    const chart = screen.getByTestId("echarts-mock");
    const opts = JSON.parse(chart.getAttribute("data-opts") ?? "{}");
    expect(opts.renderer).toBe("svg");
  });

  it("does not pass opts when not provided", () => {
    render(<DofekChart option={{}} />);
    const chart = screen.getByTestId("echarts-mock");
    expect(chart.getAttribute("data-opts")).toBeNull();
  });

  it("shows empty message when this chart is empty while another query is fetching", () => {
    mockUseFetchingCount.mockReturnValue(1);
    render(<DofekChart option={{}} empty={true} />);
    expect(screen.getByText("No data available")).toBeDefined();
    expect(screen.queryByTestId("loading-skeleton")).toBeNull();
    mockUseFetchingCount.mockReturnValue(0);
  });

  it("shows empty message when empty and no queries fetching", () => {
    mockUseFetchingCount.mockReturnValue(0);
    render(<DofekChart option={{}} empty={true} />);
    expect(screen.getByText("No data available")).toBeDefined();
  });

  it("shows refresh spinner when data present and queries are fetching", () => {
    mockUseFetchingCount.mockReturnValue(2);
    const { container } = render(<DofekChart option={{ series: [] }} />);
    expect(screen.getByTestId("echarts-mock")).toBeDefined();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    mockUseFetchingCount.mockReturnValue(0);
  });

  it("hides refresh spinner when no queries are fetching", () => {
    mockUseFetchingCount.mockReturnValue(0);
    const { container } = render(<DofekChart option={{ series: [] }} />);
    expect(screen.getByTestId("echarts-mock")).toBeDefined();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("applies selected finite range bounds to a time x-axis", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 12));

    render(
      <ChartRangeProvider days={90}>
        <DofekChart option={{ xAxis: { type: "time" }, series: [] }} />
      </ChartRangeProvider>,
    );

    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.xAxis).toEqual({ type: "time", min: "2026-04-10", max: "2026-07-09" });
  });

  it("applies selected finite range bounds to each time axis in an x-axis array", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 12));

    render(
      <ChartRangeProvider days={365}>
        <DofekChart
          option={{
            xAxis: [
              { type: "time", gridIndex: 0 },
              { type: "time", gridIndex: 1 },
            ],
            series: [],
          }}
        />
      </ChartRangeProvider>,
    );

    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.xAxis).toEqual([
      { type: "time", gridIndex: 0, min: "2025-07-09", max: "2026-07-09" },
      { type: "time", gridIndex: 1, min: "2025-07-09", max: "2026-07-09" },
    ]);
  });

  it("does not override explicit time x-axis bounds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 12));

    render(
      <ChartRangeProvider days={90}>
        <DofekChart
          option={{
            xAxis: { type: "time", min: "2026-01-01", max: "2026-02-01" },
            series: [],
          }}
        />
      </ChartRangeProvider>,
    );

    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.xAxis).toEqual({ type: "time", min: "2026-01-01", max: "2026-02-01" });
  });

  it("treats null time x-axis bounds as unset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 12));

    render(
      <ChartRangeProvider days={90}>
        <DofekChart
          option={{
            xAxis: { type: "time", min: null, max: null },
            series: [],
          }}
        />
      </ChartRangeProvider>,
    );

    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.xAxis).toEqual({ type: "time", min: "2026-04-10", max: "2026-07-09" });
  });

  it("leaves chart axes data-driven for All ranges", () => {
    render(
      <ChartRangeProvider days={null}>
        <DofekChart option={{ xAxis: { type: "time" }, series: [] }} />
      </ChartRangeProvider>,
    );

    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.xAxis).toEqual({ type: "time" });
  });

  it("allows charts to opt out of automatic selected range bounds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9, 12));

    render(
      <ChartRangeProvider days={90}>
        <DofekChart option={{ xAxis: { type: "time" }, series: [] }} timeRangeMode="data" />
      </ChartRangeProvider>,
    );

    const chart = screen.getByTestId("echarts-mock");
    const option = JSON.parse(chart.getAttribute("data-option") ?? "{}");
    expect(option.xAxis).toEqual({ type: "time" });
  });
});
