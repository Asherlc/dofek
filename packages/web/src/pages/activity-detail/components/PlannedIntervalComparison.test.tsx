// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PlannedIntervalComparison } from "./PlannedIntervalComparison.tsx";

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
  expect(container).toBeEmptyDOMElement();
});

it("shows range and point targets with recorded averages as text", () => {
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
  expect(screen.getByRole("region", { name: "Planned vs. recorded intervals" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 3, name: "Work 1" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 3, name: "Work 2" })).toBeTruthy();
  expect(screen.getByText("256 W recorded")).toBeTruthy();
  expect(screen.getByText("250–265 W planned")).toBeTruthy();
  expect(screen.getByText("260 W planned")).toBeTruthy();
});

it("shows a short timer beside the planned duration", () => {
  render(
    <PlannedIntervalComparison
      rows={[{ ...base, recordedTimerDurationSeconds: 134, timerDifferenceSeconds: -46 }]}
    />,
  );
  expect(screen.getByText("Timer duration", { selector: "span" })).toBeTruthy();
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

it("discloses how intervals were matched with native details", () => {
  const { container } = render(<PlannedIntervalComparison rows={[base]} />);
  const details = container.querySelector("details");
  expect(details?.open).toBe(false);
  expect(screen.getByText("How intervals were matched").tagName).toBe("SUMMARY");
  expect(details?.textContent).toContain("same FIT file");
  expect(details?.textContent).toContain("excludes pauses");
});
