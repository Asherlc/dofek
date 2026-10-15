// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown.tsx";

it("keeps a completed pitch scoped and opens its recorded facts", () => {
  const entry = climbingLogEntryFixture({
    title: "A recorded outing",
    recordedPitchAttemptCount: 1,
  });
  entry.attempts = [
    climbingAttemptFixture(entry.id, {
      scope: "pitch",
      outcome: "completed",
      usedAid: true,
      solo: true,
    }),
  ];
  entry.pitchResults = [
    {
      pitch: null,
      attemptIds: [entry.attempts[0]?.id ?? ""],
      recordedAttemptCount: 1,
      recordedOutcome: "completed",
      displayGrade: null,
    },
  ];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("A recorded outing")).toBeTruthy();
  expect(screen.getByText("Unidentified pitch completed · 1 recorded attempt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Details for A recorded outing" }));
  expect(screen.getByText("Used aid")).toBeTruthy();
  expect(screen.getByText("Solo")).toBeTruthy();
});
it("renders the server's unknown occurrence count with its current published display grade", () => {
  const entry = climbingLogEntryFixture({
    climb: climbingClimbFixture(),
    displayGrade: "5.10a",
    recordedClimbAttemptCount: 1,
  });
  entry.attempts = [climbingAttemptFixture(entry.id, { ropeMethod: "top_rope" })];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("Corner")).toBeTruthy();
  expect(screen.getByText("5.10a")).toBeTruthy();
  expect(screen.getByText("Whole climb outcome unknown · 1 recorded attempt")).toBeTruthy();
});

it("shows pitch completion with unknown whole-climb outcome", () => {
  const entry = climbingLogEntryFixture({
    recordedClimbAttemptCount: 1,
    recordedPitchAttemptCount: 1,
  });
  entry.attempts = [
    climbingAttemptFixture(entry.id),
    climbingAttemptFixture(entry.id, {
      id: "20000000-0000-4000-8000-000000000021",
      scope: "pitch",
      outcome: "completed",
    }),
  ];
  entry.pitchResults = [
    {
      pitch: null,
      attemptIds: [entry.attempts[1]?.id ?? ""],
      recordedAttemptCount: 1,
      recordedOutcome: "completed",
      displayGrade: null,
    },
  ];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("Unidentified pitch completed · 1 recorded attempt")).toBeTruthy();
  expect(screen.getByText("Whole climb outcome unknown · 1 recorded attempt")).toBeTruthy();
});
it("renders lead solo and aid independently", () => {
  const entry = climbingLogEntryFixture({
    recordedClimbAttemptCount: 1,
    recordedClimbOutcome: "completed",
  });
  entry.attempts = [
    climbingAttemptFixture(entry.id, {
      outcome: "completed",
      ropeMethod: "lead",
      solo: true,
      usedAid: true,
      fellOrHung: false,
    }),
  ];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  fireEvent.click(screen.getByRole("button", { name: "Details for Climbing log" }));
  for (const [label, value] of [
    ["Rope method", "Lead"],
    ["Solo", "Yes"],
    ["Used aid", "Yes"],
    ["Fell or hung", "No"],
  ]) {
    const row = screen.getByText(label ?? "").parentElement;
    if (!row) throw new Error("Expected fact row");
    expect(within(row).getByText(value ?? "")).toBeTruthy();
  }
});
it("shows a completed dab without a send label", () => {
  const entry = climbingLogEntryFixture({
    recordedClimbAttemptCount: 1,
    recordedClimbOutcome: "completed",
  });
  entry.attempts = [
    climbingAttemptFixture(entry.id, {
      outcome: "completed",
      usedAid: false,
      fellOrHung: false,
      dabbed: true,
    }),
  ];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("Whole climb completed · 1 recorded attempt")).toBeTruthy();
  expect(screen.queryByText("Sent")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details for Climbing log" }));
  const row = screen.getByText("Dabbed").parentElement;
  if (!row) throw new Error("Expected dab fact");
  expect(within(row).getByText("Yes")).toBeTruthy();
});
it("renders published and reported grades separately", () => {
  const climb = climbingClimbFixture();
  const entry = climbingLogEntryFixture({
    climb,
    climbId: climb.id,
    reportedGrades: [{ value: "5.10b", system: "yds" }],
  });
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  fireEvent.click(screen.getByRole("button", { name: "Details for Corner" }));
  expect(screen.getByText("Published climb grades")).toBeTruthy();
  expect(screen.getByText("5.10a (Yosemite Decimal System)")).toBeTruthy();
  expect(screen.getByText("Reported grades")).toBeTruthy();
  expect(screen.getByText("5.10b (Yosemite Decimal System)")).toBeTruthy();
});
