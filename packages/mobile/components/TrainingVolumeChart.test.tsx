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
      data={[{ week: "2026-01-05", attempts: null, minutes: 45 }]}
    />,
  );
  expect(screen.getByLabelText("2026-01-05: Not recorded")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Time" }));
  expect(screen.getByLabelText("2026-01-05: 45 minutes")).toBeTruthy();
  expect(screen.getByText("minutes per week")).toBeTruthy();
});
it.each([
  [60, "1:00"],
  [90, "1:30"],
  [600, "10:00"],
])("formats %i climbing minutes as %s", (minutes, duration) => {
  render(
    <TrainingVolumeChart sport="climbing" data={[{ week: "2026-01-05", attempts: 3, minutes }]} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Time" }));
  expect(screen.getByText("hours:minutes per week")).toBeTruthy();
  expect(screen.getByText(duration)).toBeTruthy();
  expect(screen.getByLabelText(`2026-01-05: ${duration} h:mm`)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Attempts" }));
  expect(screen.getByLabelText("2026-01-05: 3 attempts")).toBeTruthy();
  expect(screen.getByText("attempts per week")).toBeTruthy();
});
it("uses one duration format while preserving zero and missing climbing time", () => {
  render(
    <TrainingVolumeChart
      sport="climbing"
      data={[
        { week: "2026-01-05", attempts: 1, minutes: 90 },
        { week: "2026-01-12", attempts: 1, minutes: 45 },
        { week: "2026-01-19", attempts: 0, minutes: 0 },
        { week: "2026-01-26", attempts: null, minutes: null },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Time" }));
  expect(screen.getByLabelText("2026-01-05: 1:30 h:mm")).toBeTruthy();
  expect(screen.getByLabelText("2026-01-12: 0:45 h:mm")).toBeTruthy();
  expect(screen.getByLabelText("2026-01-19: 0:00 h:mm")).toBeTruthy();
  expect(screen.getByText("0:00")).toBeTruthy();
  expect(screen.getByLabelText("2026-01-26: Not recorded")).toBeTruthy();
  expect(screen.getByText("—")).toBeTruthy();
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
  expect(screen.getByLabelText("2026-01-05: 882 lbs")).toBeTruthy();
});
it("keeps strength time in minutes", () => {
  render(
    <TrainingVolumeChart
      sport="strength"
      data={[
        { week: "2026-01-05", recordedVolumeKg: 400, recordedSetCount: 5, durationMinutes: 90 },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Time" }));
  expect(screen.getByText("minutes per week")).toBeTruthy();
  expect(screen.getByLabelText("2026-01-05: 90 minutes")).toBeTruthy();
});
