import { formatDateTime } from "@dofek/format/format";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AreaChart, LineChart, MetricSourcePicker } from "./ActivityDetailCharts";

vi.mock("./useChartScrub", () => ({
  useChartScrub: () => ({
    touchIndex: null,
    panResponder: { panHandlers: {} },
  }),
}));

function expectVisibleDots(container: HTMLElement, count: number) {
  const dots = container.querySelectorAll('Circle[fill="#ff0000"]');
  expect(dots).toHaveLength(count);
  for (const dot of dots) {
    const svg = dot.closest("Svg");
    const radius = Number(dot.getAttribute("r"));
    const centerX = Number(dot.getAttribute("cx"));
    const centerY = Number(dot.getAttribute("cy"));
    expect(radius).toBeGreaterThan(0);
    expect(centerX - radius).toBeGreaterThanOrEqual(0);
    expect(centerX + radius).toBeLessThanOrEqual(Number(svg?.getAttribute("width")));
    expect(centerY - radius).toBeGreaterThanOrEqual(0);
    expect(centerY + radius).toBeLessThanOrEqual(Number(svg?.getAttribute("height")));
  }
}

describe("MetricSourcePicker", () => {
  it.each([
    [true, "Elevation · Apple Watch (via Apple Health) ▾"],
    [false, "Apple Watch (via Apple Health) ▾"],
  ])(
    "shows the selected source with showLabel=%s and keeps source switching accessible",
    (showLabel, text) => {
      const onChange = vi.fn();
      render(
        <MetricSourcePicker
          label="Elevation"
          showLabel={showLabel}
          sources={[
            { id: "watch", label: "Apple Watch (via Apple Health)" },
            { id: "garmin", label: "Garmin" },
          ]}
          selectedId="watch"
          onChange={onChange}
        />,
      );

      const trigger = screen.getByRole("button", {
        name: "Elevation source: Apple Watch (via Apple Health)",
      });
      expect(trigger.textContent).toBe(text);
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
      expect(onChange).toHaveBeenCalledWith("garmin");
    },
  );
});

describe("ActivityDetailCharts", () => {
  it("connects regular readings across other metrics' timestamps", () => {
    const { container } = render(
      <LineChart
        data={[130, null, 135, null, 140].map((value, second) => ({
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
          value,
        }))}
        color="#ff0000"
        label="Heart Rate"
        unit="bpm"
      />,
    );

    const line = container.querySelector('Path[stroke="#ff0000"]');
    expect(line?.getAttribute("d")?.match(/[ML]/g)).toEqual(["M", "L", "L"]);
  });

  it.each([
    ["line", LineChart],
    ["area", AreaChart],
  ])("uses proportional time spacing in the %s chart", (_, ChartComponent) => {
    const { container } = render(
      <ChartComponent
        data={[0, 1, 4].map((second) => ({
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
          value: 140,
        }))}
        color="#ff0000"
        label="Heart Rate"
        unit="bpm"
      />,
    );

    // The plot runs from x=44 to x=324; one second is a quarter of four seconds.
    const path = container.querySelector('Path[stroke="#ff0000"]')?.getAttribute("d");
    const coordinates = [...(path?.matchAll(/[ML]([\d.]+),/g) ?? [])].map((match) =>
      Number(match[1]),
    );
    expect(coordinates).toEqual([44, 114, 324]);
  });

  it("breaks the line at a long recording interruption without null rows", () => {
    const { container } = render(
      <LineChart
        data={[0, 1, 2, 20, 21].map((second) => ({
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
          value: 140,
        }))}
        color="#ff0000"
        label="Heart Rate"
        unit="bpm"
      />,
    );

    const path = container.querySelector('Path[stroke="#ff0000"]')?.getAttribute("d");
    expect(path?.match(/[ML]/g)).toEqual(["M", "L", "L", "M", "L"]);
  });

  it("closes each elevation fill at recording gaps", () => {
    const { container } = render(
      <AreaChart
        data={[0, 1, 2, 20, 21].map((second) => ({
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, 0, second)).toISOString(),
          value: 200 + second,
        }))}
        color="#ff0000"
        label="Elevation"
        unit="m"
      />,
    );
    const outline = container.querySelector('Path[stroke="#ff0000"]')?.getAttribute("d");
    const fill = container.querySelector('Path[fill="url(#areaGrad)"]')?.getAttribute("d");
    expect(outline?.match(/[ML]/g)).toEqual(["M", "L", "L", "M", "L"]);
    expect(fill?.match(/Z/g)).toHaveLength(2);
  });

  const data = [
    { recordedAt: "2026-10-04T16:52:51.440Z", value: 130 },
    { recordedAt: "2026-10-04T16:53:51.440Z", value: null },
    { recordedAt: "2026-10-04T16:54:51.440Z", value: 145 },
  ];

  it.each([
    ["line", LineChart],
    ["area", AreaChart],
  ])("provides a VoiceOver summary and exact values for the %s chart", (_, ChartComponent) => {
    render(
      <ChartComponent data={data} color="#ff0000" label="Heart Rate" unit="beats per minute" />,
    );

    expect(
      screen.getByRole("image", {
        name: "Heart Rate. Heart Rate over activity time. Dots mark recorded samples; gaps indicate unobserved time.",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
    expect(screen.getByText(`Sample 1 · ${formatDateTime(data[0].recordedAt)}`)).toBeDefined();
    expect(screen.getByText("130 beats per minute")).toBeDefined();
    expect(screen.getByText("145 beats per minute")).toBeDefined();
  });

  it("identifies separate samples with the same timestamp and value", () => {
    const sample = { recordedAt: "2026-10-04T16:52:51.440Z", value: 130 };
    render(
      <LineChart
        data={[sample, sample]}
        color="#ff0000"
        label="Heart Rate"
        unit="beats per minute"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
    const timestamp = formatDateTime(sample.recordedAt);
    expect(screen.getByLabelText(`Sample 1 · ${timestamp}: 130 beats per minute`)).toBeDefined();
    expect(screen.getByLabelText(`Sample 2 · ${timestamp}: 130 beats per minute`)).toBeDefined();
  });

  it.each([
    ["line", LineChart],
    ["area", AreaChart],
  ])("rounds fractional readings to whole numbers for the %s chart", (_, ChartComponent) => {
    render(
      <ChartComponent
        data={data.map((sample, index) => ({
          ...sample,
          value: [43.383949279785156, null, 76.92308044433594][index] ?? null,
        }))}
        color="#ff0000"
        label="Heart Rate"
        unit="beats per minute"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
    expect(screen.getByText("43 beats per minute")).toBeDefined();
    expect(screen.getByText("77 beats per minute")).toBeDefined();
  });

  it("renders isolated readings as dots without drawing across missing samples", () => {
    const { container } = render(
      <LineChart data={data} color="#ff0000" label="Heart Rate" unit="beats per minute" />,
    );

    expectVisibleDots(container, 2);
    const line = container.querySelector('Path[stroke="#ff0000"]');
    expect(line?.getAttribute("d")?.match(/[ML]/g)).toEqual(["M", "M"]);
  });

  it.each([{ values: [0] }, { values: [null, 0, null] }])(
    "renders a single recorded zero: $values",
    ({ values }) => {
      const { container } = render(
        <LineChart
          data={values.map((value, index) => ({
            recordedAt: new Date(Date.UTC(2026, 9, 20, 16, index)).toISOString(),
            value,
          }))}
          color="#ff0000"
          label="Power"
          unit="W"
        />,
      );

      expectVisibleDots(container, 1);
      fireEvent.click(screen.getByRole("button", { name: "View Power data" }));
      expect(screen.getByText("0 W")).toBeDefined();
    },
  );

  it("draws each continuous segment and marks sparse readings", () => {
    const { container } = render(
      <LineChart
        data={[130, 135, null, 145, null, 150, 155].map((value, index) => ({
          recordedAt: new Date(Date.UTC(2026, 9, 20, 16, index)).toISOString(),
          value,
        }))}
        color="#ff0000"
        label="Heart Rate"
        unit="beats per minute"
      />,
    );

    const line = container.querySelector('Path[stroke="#ff0000"]');
    expect(line?.getAttribute("d")?.match(/[ML]/g)).toEqual(["M", "L", "M", "M", "L"]);
    expectVisibleDots(container, 5);
  });

  it("scales the elevation profile to the recorded altitude range", () => {
    render(
      <AreaChart
        data={[
          { recordedAt: "2026-10-04T16:52:51.440Z", value: 7400 },
          { recordedAt: "2026-10-04T16:53:51.440Z", value: 7900 },
          { recordedAt: "2026-10-04T16:54:51.440Z", value: 8400 },
        ]}
        color="#6b7280"
        label="Elevation Profile"
        unit="ft"
      />,
    );

    for (const tick of ["7400", "7650", "7900", "8150", "8400"]) {
      expect(screen.getByText(tick)).toBeDefined();
    }
  });
});
