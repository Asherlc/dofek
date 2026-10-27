// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryDetails } from "./ClimbingLogEntryDetails.tsx";

it("renders the climb name, date, location, grades and known attempt facts", () => {
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
    climbedOn: "2026-10-01",
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
  expect(screen.getByText("2026-10-01")).toBeTruthy();
  expect(screen.getByText("Wall")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Grades" })).toBeTruthy();
  expect(screen.getByText("5.10a (Yosemite Decimal System)")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Pitch grades" })).toBeTruthy();
  expect(screen.getByText("5.9 (Yosemite Decimal System)")).toBeTruthy();
  expect(screen.getByText("Reported grades")).toBeTruthy();
  expect(screen.getByText("6b (French)")).toBeTruthy();
  expect(screen.getByText("Used aid")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Lower pitch · Attempt 4" })).toBeTruthy();
  expect(screen.getByText("Source note")).toBeTruthy();
});

it("uses the recorded attempt order when no named pitch is available", () => {
  const log = climbingLogEntryFixture({ title: "Indoor session" });
  log.attempts = [climbingAttemptFixture(log.id, { attemptIndex: 3, ropeMethod: "top_rope" })];
  render(<ClimbingLogEntryDetails entry={log} />);
  expect(screen.getByText("Indoor session")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Attempt 3" })).toBeTruthy();
  expect(screen.getByText("Top rope")).toBeTruthy();
});

it("shows Mountain Project facts without numbering an unrecorded attempt", () => {
  const log = climbingLogEntryFixture({
    providerId: "mountain-project",
    recordedClimbAttemptCount: null,
  });
  log.attempts = [climbingAttemptFixture(log.id, { ropeMethod: "top_rope" })];
  render(<ClimbingLogEntryDetails entry={log} />);
  expect(screen.getByRole("heading", { name: "Recorded result" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Climb" })).toBeTruthy();
  expect(screen.getByText("Top rope")).toBeTruthy();
});

it.each([1, 3])("preserves known attempt order %s when the total is unknown", (attemptIndex) => {
  const log = climbingLogEntryFixture({
    providerId: "mountain-project",
    recordedClimbAttemptCount: null,
  });
  log.attempts = [climbingAttemptFixture(log.id, { attemptIndex, ropeMethod: "lead" })];
  render(<ClimbingLogEntryDetails entry={log} />);
  expect(screen.getByRole("heading", { name: "Recorded result" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: `Attempt ${attemptIndex}` })).toBeTruthy();
});

it("identifies a pitch attempt whose pitch is unreported", () => {
  const log = climbingLogEntryFixture({ title: "Multi-pitch outing" });
  log.attempts = [climbingAttemptFixture(log.id, { scope: "pitch", ropeMethod: "lead" })];
  render(<ClimbingLogEntryDetails entry={log} />);
  expect(screen.getByRole("heading", { name: "Pitch attempt" })).toBeTruthy();
  expect(screen.getByText("Lead")).toBeTruthy();
});

vi.mock("./ClimbingPhotos", () => ({
  ClimbingPhotos: ({ id }: { id: string }) => <div data-testid="ascent-photos">{id}</div>,
}));

it.each(["kaya", "openbeta"])(
  "uses the server-selected KAYA photo source with preferred provider %s",
  (providerId) => {
    const sourceId = "20000000-0000-4000-8000-000000000099";
    const entry = climbingLogEntryFixture({
      providerId,
      externalId: "source-record",
      photoLogEntryId: sourceId,
    });
    render(<ClimbingLogEntryDetails entry={entry} />);
    expect(screen.getByTestId("ascent-photos").textContent).toBe(sourceId);
  },
);
it.each([
  { providerId: "kaya", externalId: "kaya:session:123:attempted:456" },
  { providerId: "openbeta", externalId: "source-record" },
  { providerId: "kaya", externalId: null },
])("omits the gallery when the server reports no eligible photo source: %o", (source) => {
  render(
    <ClimbingLogEntryDetails
      entry={climbingLogEntryFixture({ ...source, photoLogEntryId: null })}
    />,
  );
  expect(screen.queryByTestId("ascent-photos")).toBeNull();
});

it("displays all recorded grips and the source wall category", () => {
  render(
    <ClimbingLogEntryDetails
      entry={climbingLogEntryFixture({
        holdTypes: ["crimp", "volume", "no_grips"],
        wallAngle: { category: "roof" },
      })}
    />,
  );
  expect(screen.getByText("Hold types: crimp, volume, no grips")).toBeInTheDocument();
  expect(screen.getByText("Wall angle: Roof")).toBeInTheDocument();
});
