// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryDetails } from "./ClimbingLogEntryDetails";

it("renders the climb, grades, known attempt facts and notes", () => {
  const climb = climbingClimbFixture();
  climb.coordinates = { latitude: 37.5, longitude: -122.25 };
  climb.pitches = [
    {
      id: "20000000-0000-4000-8000-000000000020",
      climbId: climb.id,
      externalId: "p1",
      number: 1,
      name: "Lower pitch",
      publishedGrades: [{ value: "5.9", system: "yds" }],
    },
  ];
  const log = climbingLogEntryFixture({
    climb,
    climbId: climb.id,
    notes: "Source note",
    reportedGrades: [{ value: "6b", system: "french" }],
    raw: { sourceMarker: "Recorded payload" },
  });
  log.attempts = [
    climbingAttemptFixture(log.id, {
      scope: "pitch",
      attemptIndex: 4,
      pitchId: climb.pitches[0]?.id ?? null,
      outcome: "completed",
      ropeMethod: "lead",
      solo: true,
      usedAid: true,
    }),
  ];
  render(<ClimbingLogEntryDetails entry={log} />);
  expect(screen.getByText("Corner")).toBeTruthy();
  expect(screen.getByText("Wall")).toBeTruthy();
  expect(screen.getByText("Grades")).toBeTruthy();
  expect(screen.getByText("5.10a (Yosemite Decimal System)")).toBeTruthy();
  expect(screen.getByText("Pitch grades")).toBeTruthy();
  expect(screen.getByText("Lower pitch · Attempt 4")).toBeTruthy();
  expect(screen.getByText("5.9 (Yosemite Decimal System)")).toBeTruthy();
  expect(screen.getByText("Reported grades")).toBeTruthy();
  expect(screen.getByText("6b (French)")).toBeTruthy();
  expect(screen.getByText("Used aid")).toBeTruthy();
  expect(screen.getByText("Lead")).toBeTruthy();
  expect(screen.getByText("Source note")).toBeTruthy();
});
