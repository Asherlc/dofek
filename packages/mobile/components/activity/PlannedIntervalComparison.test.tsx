// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PlannedIntervalComparison } from "./PlannedIntervalComparison";

const base = {
  intervalIndex: 0,
  startOffsetSeconds: 0,
  endOffsetSeconds: 180,
  label: "Work 1",
  target: { kind: "range" as const, minWatts: 250, maxWatts: 265 },
  plannedDurationSeconds: 180,
  recordedTimerDurationSeconds: 180,
  timerDifferenceSeconds: 0,
  averagePowerWatts: 256,
};

it("renders nothing without eligible rows", () => {
  const { container } = render(<PlannedIntervalComparison rows={[]} />);
  expect(container.childElementCount).toBe(0);
});

it("shows range and point targets as text with an accessible summary", () => {
  render(
    <PlannedIntervalComparison
      rows={[
        base,
        {
          ...base,
          intervalIndex: 1,
          startOffsetSeconds: 180,
          endOffsetSeconds: 360,
          label: "Work 2",
          target: { kind: "point", watts: 260 },
          averagePowerWatts: 261,
        },
      ]}
    />,
  );
  expect(screen.getByText("256 W recorded")).toBeTruthy();
  expect(screen.getByText("250–265 W planned")).toBeTruthy();
  expect(screen.getByText("260 W planned")).toBeTruthy();
  expect(
    screen.getByLabelText("Work 1: 256 W recorded, 250–265 W planned. Timer 3:00, 3:00 planned."),
  ).toBeTruthy();
});

it("shows a short timer beside the planned duration", () => {
  render(
    <PlannedIntervalComparison
      rows={[{ ...base, recordedTimerDurationSeconds: 134, timerDifferenceSeconds: -46 }]}
    />,
  );
  expect(screen.getByText("2:14")).toBeTruthy();
  expect(screen.getByText("0:46 short of 3:00")).toBeTruthy();
});

it("keeps missing power unavailable and a recorded zero as 0 W", () => {
  render(
    <PlannedIntervalComparison
      rows={[
        { ...base, averagePowerWatts: null },
        { ...base, intervalIndex: 1, label: "Work 2", averagePowerWatts: 0 },
      ]}
    />,
  );
  expect(screen.getByText("Power unavailable")).toBeTruthy();
  expect(screen.getByText("0 W recorded")).toBeTruthy();
});

it("discloses how intervals were matched on demand", () => {
  render(<PlannedIntervalComparison rows={[base]} />);
  const toggle = screen.getByRole("button", { name: "How intervals were matched" });
  expect(screen.queryByText(/same FIT file/)).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText(/same FIT file/)).toBeTruthy();
  expect(screen.getByText(/excludes pauses/)).toBeTruthy();
});

it("labels timer duration and the planned/recorded legend, and speaks a missing timer naturally", () => {
  render(
    <PlannedIntervalComparison
      rows={[{ ...base, recordedTimerDurationSeconds: null, timerDifferenceSeconds: null }]}
    />,
  );
  expect(screen.getByText("Timer duration")).toBeTruthy();
  expect(screen.getByText("Planned power")).toBeTruthy();
  expect(screen.getByText("Recorded average")).toBeTruthy();
  expect(
    screen.getByLabelText(
      "Work 1: 256 W recorded, 250–265 W planned. Timer unavailable, 3:00 planned.",
    ),
  ).toBeTruthy();
});
