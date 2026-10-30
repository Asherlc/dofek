import { formatDateTime } from "@dofek/format/format";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AreaChart, LineChart } from "./ActivityDetailCharts";

const scrub = vi.hoisted(() => {
  const callbacks: { onHoverTime?: (timestamp: number | null) => void } = {};
  return callbacks;
});
vi.mock("./useChartScrub", () => ({
  useChartScrub: (options: typeof scrub) => {
    scrub.onHoverTime = options.onHoverTime;
    return { touchIndex: null, panResponder: { panHandlers: {} } };
  },
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

describe("ActivityDetailCharts", () => {
  it("lets chart scrubbing and accessible selection replace a list selection", () => {
    function LinkedChart() {
      const [highlightedClimbId, selectClimb] = useState<string | null>("first");
      return (
        <LineChart
          data={[
            { recordedAt: "2026-10-18T10:00:00Z", value: 130 },
            { recordedAt: "2026-10-18T12:00:00Z", value: 150 },
          ]}
          color="#ff0000"
          label="Heart Rate"
          unit="bpm"
          highlightedClimbId={highlightedClimbId}
          onSelectClimb={selectClimb}
          climbAnnotations={[
            { id: "first", label: "Earlier", startedAt: "2026-10-18T10:00:00Z", endedAt: null },
            { id: "second", label: "Later", startedAt: "2026-10-18T10:30:00Z", endedAt: null },
          ]}
        />
      );
    }
    render(<LinkedChart />);
    expect(screen.getByText(/Earlier ·/)).toBeDefined();
    act(() => scrub.onHoverTime?.(Date.parse("2026-10-18T10:30:00Z")));
    expect(screen.getByText(/Later ·/)).toBeDefined();
    expect(screen.queryByText(/Earlier ·/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
    fireEvent.click(screen.getByRole("button", { name: /Earlier/ }));
    expect(screen.getByText(/Earlier ·/)).toBeDefined();
  });
  it("highlights the selected list occurrence and range, then clears the highlight", () => {
    const args = {
      data: [
        { recordedAt: "2026-10-18T17:30:00Z", value: 130 },
        { recordedAt: "2026-10-18T17:31:00Z", value: 150 },
      ],
      color: "#ff0000",
      label: "Heart Rate",
      unit: "bpm",
      climbAnnotations: [
        { id: "first", label: "First", startedAt: "2026-10-18T17:30:10Z", endedAt: null },
        { id: "repeat", label: "Repeat", startedAt: "2026-10-18T17:30:30Z", endedAt: null },
        {
          id: "range",
          label: "Range",
          startedAt: "2026-10-18T17:30:00Z",
          endedAt: "2026-10-18T17:30:40Z",
        },
        { id: "outside", label: "Outside", startedAt: "2026-10-18T17:32:00Z", endedAt: null },
      ],
    };
    const view = render(<LineChart {...args} highlightedClimbId="repeat" />);
    const lines = () => view.container.querySelectorAll('Line[stroke="#a78bfa"]');
    expect(lines()[1]?.getAttribute("stroke-width")).toBe("3");
    expect(lines()[0]?.getAttribute("stroke-width")).toBe("1.5");
    expect(screen.getByText(/Repeat ·/)).toBeDefined();
    view.rerender(<LineChart {...args} highlightedClimbId="range" />);
    expect(view.container.querySelector('Rect[fill="#a78bfa"]')?.getAttribute("fill-opacity")).toBe(
      "0.36",
    );
    expect(screen.getByText(/Range ·/)).toBeDefined();
    view.rerender(<LineChart {...args} highlightedClimbId={null} />);
    expect(lines()[1]?.getAttribute("stroke-width")).toBe("1.5");
    expect(screen.queryByText(/Range ·/)).toBeNull();
    view.rerender(<LineChart {...args} highlightedClimbId="outside" />);
    expect(screen.queryByText(/Outside/)).toBeNull();
  });
  it.each([null, "2026-10-18T10:05:00Z"])(
    "selects the nearest climb marker near an earlier climb ending at %s",
    (endedAt) => {
      render(
        <LineChart
          data={[
            { recordedAt: "2026-10-18T10:00:00Z", value: 130 },
            { recordedAt: "2026-10-18T12:00:00Z", value: 150 },
          ]}
          color="#ff0000"
          label="Heart Rate"
          unit="bpm"
          climbAnnotations={[
            { id: "first", label: "Earlier · V3", startedAt: "2026-10-18T10:00:00Z", endedAt },
            { id: "second", label: "Later · V4", startedAt: "2026-10-18T10:03:00Z", endedAt: null },
          ]}
        />,
      );
      act(() => scrub.onHoverTime?.(Date.parse("2026-10-18T10:03:05Z")));
      expect(screen.getByText(/Later · V4 ·/)).toBeDefined();
      expect(screen.queryByText(/Earlier · V3 ·/)).toBeNull();
    },
  );
  it("positions climb markers and clipped bands with selectable exact climb details", () => {
    const { container } = render(
      <LineChart
        data={[
          { recordedAt: "2026-10-18T17:30:00Z", value: 130 },
          { recordedAt: "2026-10-18T17:31:00Z", value: 150 },
        ]}
        color="#ff0000"
        label="Heart Rate"
        unit="bpm"
        climbAnnotations={[
          { id: "ascent", label: "Corner · V3", startedAt: "2026-10-18T17:30:30Z", endedAt: null },
          {
            id: "range",
            label: "Arete · V4",
            startedAt: "2026-10-18T17:29:00Z",
            endedAt: "2026-10-18T17:30:30Z",
          },
          { id: "outside", label: "Outside", startedAt: "2026-10-18T17:32:00Z", endedAt: null },
        ]}
      />,
    );
    const marker = container.querySelector('Line[stroke="#a78bfa"]');
    expect(Number(marker?.getAttribute("x1"))).toBe(184);
    const band = container.querySelector('Rect[fill="#a78bfa"]');
    expect(Number(band?.getAttribute("x"))).toBe(44);
    expect(Number(band?.getAttribute("width"))).toBe(140);
    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate data" }));
    fireEvent.click(screen.getByRole("button", { name: /Corner · V3/ }));
    expect(screen.getAllByText(/Corner · V3/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Outside/)).toBeNull();
  });
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
