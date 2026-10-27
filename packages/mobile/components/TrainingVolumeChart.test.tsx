// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TrainingVolumeChart } from "./TrainingVolumeChart";

vi.mock("../lib/units", () => ({ useUnitConverter: () => new UnitConverter("imperial") }));

afterEach(cleanup);
it("switches climbing metrics and preserves missing attempts", () => {
  render(
    <TrainingVolumeChart
      sport="climbing"
      data={[{ week: "2026-01-05", attempts: null, minutes: 60 }]}
    />,
  );
  expect(screen.getByLabelText("2026-01-05: Not recorded")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Time" }));
  expect(screen.getByLabelText("2026-01-05: 60 minutes")).toBeTruthy();
});
it("switches strength metrics", () => {
  render(
    <TrainingVolumeChart
      sport="strength"
      data={[
        { week: "2026-01-05", recordedVolumeKg: 400, recordedSetCount: 5, durationMinutes: 60 },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Sets" }));
  expect(screen.getByLabelText("2026-01-05: 5 sets")).toBeTruthy();
});
it("formats lifted weight in the selected unit system", () => {
  render(
    <TrainingVolumeChart
      sport="strength"
      data={[
        { week: "2026-01-05", recordedVolumeKg: 400, recordedSetCount: 5, durationMinutes: 60 },
      ]}
    />,
  );
  const units = new UnitConverter("imperial");
  expect(
    screen.getByLabelText(`2026-01-05: ${units.convertWeight(400)} ${units.weightLabel}`),
  ).toBeTruthy();
});
