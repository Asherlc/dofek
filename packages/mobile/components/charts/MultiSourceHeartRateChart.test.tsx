import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type HeartRateSourceData,
  MultiSourceHeartRateChart,
  sourceColor,
} from "./MultiSourceHeartRateChart";

const twoSourceData: HeartRateSourceData[] = [
  {
    providerId: "whoop_ble",
    providerLabel: "WHOOP BLE",
    samples: [
      { time: "2026-04-12T10:00:00Z", heartRate: 72 },
      { time: "2026-04-12T10:01:00Z", heartRate: 74 },
    ],
  },
  {
    providerId: "apple_health",
    providerLabel: "Apple Health",
    samples: [
      { time: "2026-04-12T10:00:00Z", heartRate: 70 },
      { time: "2026-04-12T10:01:00Z", heartRate: 73 },
    ],
  },
];

describe("MultiSourceHeartRateChart", () => {
  it("renders nothing with empty sources", () => {
    const { container } = render(
      <MultiSourceHeartRateChart sources={[]} width={300} height={150} />,
    );
    expect(container.querySelector("polyline")).toBeNull();
  });

  it("renders one polyline per source", () => {
    const { container } = render(
      <MultiSourceHeartRateChart sources={twoSourceData} width={300} height={150} />,
    );

    const polylines = container.querySelectorAll("polyline");
    expect(polylines).toHaveLength(2);
  });

  it("provides a VoiceOver summary and exact source values", () => {
    render(<MultiSourceHeartRateChart sources={twoSourceData} width={300} height={150} />);

    expect(
      screen.getByRole("image", {
        name: "Heart rate by source. Heart rate samples compared across recorded sources.",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View Heart rate by source data" }));
    expect(screen.getAllByText("WHOOP BLE").length).toBeGreaterThan(0);
    expect(screen.getByText(/72 beats per minute/)).toBeDefined();
    expect(screen.getAllByText("Apple Health").length).toBeGreaterThan(0);
    expect(screen.getByText(/70 beats per minute/)).toBeDefined();
  });

  it("uses different colors per source", () => {
    const { container } = render(
      <MultiSourceHeartRateChart sources={twoSourceData} width={300} height={150} />,
    );

    const polylines = container.querySelectorAll("polyline");
    const color1 = polylines[0]?.getAttribute("stroke");
    const color2 = polylines[1]?.getAttribute("stroke");
    expect(color1).not.toBe(color2);
  });

  it("renders grid lines", () => {
    const { container } = render(
      <MultiSourceHeartRateChart sources={twoSourceData} width={300} height={150} />,
    );

    const lines = container.querySelectorAll("line");
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("sourceColor", () => {
  it("cycles through the palette", () => {
    const color0 = sourceColor(0);
    const color1 = sourceColor(1);
    expect(color0).not.toBe(color1);
    // Should wrap around
    expect(sourceColor(6)).toBe(color0);
  });
});
