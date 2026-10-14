// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryDetails } from "./ClimbingLogEntryDetails.tsx";

it("renders current shared location, owned grades, pitch facts, notes and disclosed provenance", () => {
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
      pitchId: climb.pitches[0]?.id ?? null,
      outcome: "completed",
      ropeMethod: "lead",
      solo: true,
      usedAid: true,
    }),
  ];
  render(<ClimbingLogEntryDetails entry={log} />);
  expect(screen.getByText("Date unknown")).toBeTruthy();
  expect(screen.getByText("Wall")).toBeTruthy();
  expect(screen.getByText("37.5, −122.25")).toBeTruthy();
  expect(screen.getByText("Published climb grades")).toBeTruthy();
  expect(screen.getByText("5.10a (Yosemite Decimal System)")).toBeTruthy();
  expect(screen.getByText("Published pitch grades")).toBeTruthy();
  expect(screen.getByText("5.9 (Yosemite Decimal System)")).toBeTruthy();
  expect(screen.getByText("Reported grades")).toBeTruthy();
  expect(screen.getByText("6b (French)")).toBeTruthy();
  expect(screen.getByText("Used aid")).toBeTruthy();
  expect(screen.getByText("Fell or hung")).toBeTruthy();
  expect(screen.getByText("Source note")).toBeTruthy();
  fireEvent.click(screen.getByText("Raw provider data"));
  expect(screen.getByText(/Recorded payload/)).toBeTruthy();
});
