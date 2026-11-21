// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/units", () => ({ useUnitConverter: () => new UnitConverter("metric") }));

import { RecordedDailyMetrics } from "./RecordedDailyMetrics";

const row = {
  date: "2026-03-01",
  metric: "weight" as const,
  value: 70,
  unit: "kg",
  providerId: "intervals.icu",
  sourceName: null,
};

afterEach(cleanup);

describe("RecordedDailyMetrics (mobile)", () => {
  it("lists provider-reported rows with the possibility-worded Garmin disclosure", () => {
    render(<RecordedDailyMetrics rows={[row]} />);
    expect(screen.getByText("Mar 1")).toBeTruthy();
    expect(screen.getByText("Weight")).toBeTruthy();
    expect(screen.getByText("70.0 kg")).toBeTruthy();
    expect(screen.getByText("Measurements may include data from Garmin devices.")).toBeTruthy();
  });

  it("omits the disclosure for other providers and renders nothing without rows", () => {
    const { container, rerender } = render(
      <RecordedDailyMetrics rows={[{ ...row, providerId: "withings" }]} />,
    );
    expect(screen.queryByText(/Garmin/)).toBeNull();
    rerender(<RecordedDailyMetrics rows={undefined} />);
    expect(container.textContent).toBe("");
  });
});
