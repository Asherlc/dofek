// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => new UnitConverter("metric"),
}));

import { RecordedDailyMetrics } from "./RecordedDailyMetrics.tsx";

const intervalsRow = {
  date: "2026-03-01",
  metric: "weight" as const,
  value: 70,
  unit: "kg",
  providerId: "intervals.icu",
  sourceName: null,
};

afterEach(cleanup);

describe("RecordedDailyMetrics", () => {
  it("lists provider-reported observations with a possibility-worded Garmin disclosure", () => {
    render(<RecordedDailyMetrics rows={[intervalsRow]} />);
    expect(screen.getByText("Mar 1")).toBeTruthy();
    expect(screen.getByText("Weight")).toBeTruthy();
    expect(screen.getByText("70.0 kg")).toBeTruthy();
    expect(screen.getByText(/Intervals\.icu/)).toBeTruthy();
    expect(screen.getByText("Measurements may include data from Garmin devices.")).toBeTruthy();
  });

  it("omits the Garmin disclosure for other providers", () => {
    render(<RecordedDailyMetrics rows={[{ ...intervalsRow, providerId: "withings" }]} />);
    expect(screen.queryByText(/Garmin/)).toBeNull();
  });

  it("renders nothing without rows", () => {
    const { container } = render(<RecordedDailyMetrics rows={undefined} />);
    expect(container.textContent).toBe("");
  });
});
