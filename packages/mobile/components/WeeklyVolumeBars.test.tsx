// @vitest-environment jsdom
import { formatDurationMinutesClock } from "@dofek/format/format";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WeeklyVolumeBars } from "./WeeklyVolumeBars";

afterEach(cleanup);
it("labels recorded zero separately from unknown volume", () => {
  render(
    <WeeklyVolumeBars
      unit="km"
      weeks={[
        { week: "2026-10-12", value: 0 },
        { week: "2026-10-19", value: null },
      ]}
    />,
  );
  expect(screen.getByLabelText("2026-10-12: 0 km")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-19: Not recorded")).toBeTruthy();
});
it("uses formatted values in visible text and accessibility labels", () => {
  render(
    <WeeklyVolumeBars
      unit="hours:minutes"
      weeks={[{ week: "2026-10-12", value: 90 }]}
      formatValue={formatDurationMinutesClock}
    />,
  );
  expect(screen.getByText("1:30")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-12: 1:30")).toBeTruthy();
});
