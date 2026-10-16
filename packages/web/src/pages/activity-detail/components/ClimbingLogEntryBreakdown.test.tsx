// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown.tsx";

it("groups located canonical logs by area and highlights repeated occurrences across missing GPS", () => {
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
  const cards = within(screen.getByRole("region", { name: "Attached climbing logs" })).getAllByRole(
    "listitem",
  );
  expect(cards).toHaveLength(3);
  expect(cards[0]).toHaveTextContent("Corner");
  expect(cards[1]).toHaveTextContent("Corner");
  expect(cards[2]).toHaveTextContent("Indoor");
  expect(cards[1]).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("heading", { name: "Wall" })).toBeInTheDocument();
  expect(screen.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(2);
});

it("keeps separate area groups and each attachment's original occurrence number", () => {
  const firstClimb = climbingClimbFixture();
  const otherClimb = {
    ...firstClimb,
    name: "Left Arete",
    areaPath: firstClimb.areaPath.map((area) => ({ ...area, id: "other-area", name: "Boulder" })),
  };
  const first = climbingLogEntryFixture({ id: "first", climb: firstClimb });
  const other = climbingLogEntryFixture({ id: "other", climb: otherClimb });
  const repeat = climbingLogEntryFixture({ id: "repeat", climb: firstClimb });
  const onAttach = vi.fn();
  render(<ClimbingLogEntryBreakdown entries={[first, other, repeat]} onAttach={onAttach} />);
  expect(
    screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
  ).toEqual(["Wall", "Boulder"]);
  const wall = screen.getByRole("list", { name: "Wall climbs" });
  expect(within(wall).getAllByText("Corner")).toHaveLength(2);
  expect(
    within(screen.getByRole("list", { name: "Boulder climbs" })).getByText("Left Arete"),
  ).toBeTruthy();
  fireEvent.click(
    within(wall).getByRole("button", { name: "Attach entry 3, Corner to this activity" }),
  );
  expect(onAttach).toHaveBeenCalledWith("repeat");
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
  expect(screen.getByText("Unidentified pitch completed · Attempts: 1")).toBeTruthy();
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
  expect(screen.getByText("Attempts: 1")).toBeTruthy();
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
  expect(screen.getByText("Unidentified pitch completed · Attempts: 1")).toBeTruthy();
  expect(screen.getByText("Attempts: 1")).toBeTruthy();
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
  expect(screen.getByText("Completed · Attempts: 1")).toBeTruthy();
  expect(screen.queryByText("Sent")).toBeNull();
});
