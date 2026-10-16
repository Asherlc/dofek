// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown.tsx";

it("keeps located canonical logs in ordered cards and highlights repeated occurrences across missing GPS", () => {
  const first = climbingLogEntryFixture({ climb: climbingClimbFixture() });
  const repeat = { ...first, id: "repeat" };
  const location = {
    coordinates: { latitude: 37.234, longitude: -122.111 },
    scope: "area" as const,
    objectId: "area",
    providerId: "openbeta",
    name: "Goat Rock",
  };
  render(
    <ClimbingLogEntryBreakdown
      entries={[first, climbingLogEntryFixture({ id: "indoor", title: "Indoor" }), repeat]}
      locations={{ [first.id]: location, repeat: location }}
      selectedEntryId="repeat"
    />,
  );
  const cards = screen.getByRole("list", { name: "Attached climbing logs" }).children;
  expect(cards).toHaveLength(3);
  expect(cards[0]).toHaveTextContent("Entry 1");
  expect(cards[1]).toHaveTextContent("Entry 2");
  expect(cards[2]).toHaveTextContent("Entry 3 · Selected");
  expect(cards[2]).toHaveAttribute("aria-current", "true");
  expect(screen.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(2);
  expect(screen.getAllByText("Area location: Goat Rock · OpenBeta")).toHaveLength(2);
});

it("keeps a completed pitch scoped to its recorded result", () => {
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
  expect(screen.getByText("Whole climb · 1 recorded attempt")).toBeTruthy();
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
  expect(screen.getByText("Whole climb · 1 recorded attempt")).toBeTruthy();
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
});
