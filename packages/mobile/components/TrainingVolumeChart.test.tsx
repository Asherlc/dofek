// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TrainingVolumeChart } from "./TrainingVolumeChart";

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
