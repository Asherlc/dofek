/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClimbingActivityEntryRow } from "../../../../../server/src/contracts/climbing-context-contracts.ts";
import { ClimbingEntryBreakdown } from "./ClimbingEntryBreakdown.tsx";

describe("ClimbingEntryBreakdown", () => {
  it("shows a Mountain Project top-rope tick without unavailable outcome placeholders", () => {
    const entry: ClimbingActivityEntryRow = {
      id: "swiss-cheese",
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.4",
      sent: null,
      attemptCount: null,
      attempts: [],
      ascentType: null,
      holdType: null,
      routeName: "Swiss Cheese",
      locationName: "California > Goat Rock",
      lead: false,
      sourceName: "Mountain Project",
      sourceLinks: [
        {
          providerId: "mountain-project",
          kind: "route",
          url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
        },
      ],
      wallAngleDegrees: null,
      context: {
        providerId: "mountain-project",
        locationPath: [
          { name: "California", externalId: null, kind: null },
          { name: "Goat Rock", externalId: null, kind: null },
        ],
        board: null,
        wallAngle: null,
        climbStyle: "top-rope",
        resultStyle: null,
      },
    };
    render(<ClimbingEntryBreakdown entries={[entry]} />);
    expect(screen.getByText("Swiss Cheese")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" }).getAttribute("href"),
    ).toBe("https://www.mountainproject.com/route/105734732/swiss-cheese");
    expect(screen.getByText("5.4")).toBeTruthy();
    expect(screen.getByText("California > Goat Rock")).toBeTruthy();
    expect(screen.getByText("Top rope")).toBeTruthy();
    expect(screen.getByText("Mountain Project")).toBeTruthy();
    expect(screen.queryByText("Result unknown")).toBeNull();
    expect(screen.queryByText(/outcome|attempt/i)).toBeNull();
  });

  it.each([
    ["Onsight", null],
    ["Flash", null],
    ["Repeat", null],
    ["Repeat", 3],
    ["Redpoint", 7],
  ] as const)(
    "uses the %s badge to communicate a successful ascent with %s recorded attempts",
    (ascentType, attemptCount) => {
      const entry: ClimbingActivityEntryRow = {
        id: "entry-1",
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.6",
        sent: true,
        attemptCount,
        attempts: [],
        ascentType,
        holdType: null,
        routeName: "Left Arete",
        locationName: "Kombucha Crag",
        lead: true,
        sourceName: "Mountain Project",
        sourceLinks: [],
        wallAngleDegrees: null,
        context: {
          providerId: "mountain-project",
          locationPath: [{ name: "Kombucha Crag", externalId: null, kind: null }],
          board: null,
          wallAngle: null,
          climbStyle: "lead",
          resultStyle: ascentType,
        },
      };
      render(<ClimbingEntryBreakdown entries={[entry]} />);
      expect(screen.getByText("Left Arete")).toBeTruthy();
      expect(screen.getByText("5.6")).toBeTruthy();
      expect(screen.getByText(ascentType)).toBeTruthy();
      if (attemptCount != null) {
        expect(screen.getByText(`${attemptCount} attempts`)).toBeTruthy();
      } else {
        expect(screen.queryByText(/attempt|\bSent\b/i)).toBeNull();
      }
    },
  );

  it("combines recorded context with unknown counts and individual attempts", () => {
    const entry: ClimbingActivityEntryRow = {
      id: "entry-1",
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.9",
      sent: false,
      attemptCount: null,
      attempts: [{ attemptIndex: 1, failureReason: "fell", outcome: "failed", notes: null }],
      ascentType: null,
      holdType: "crimp",
      routeName: "Corner",
      locationName: "Crag > Wall",
      lead: false,
      sourceName: "Mountain Project",
      sourceLinks: [],
      wallAngleDegrees: null,
      context: {
        providerId: "mountain-project",
        locationPath: [
          { name: "Crag", externalId: null, kind: null },
          { name: "Wall", externalId: null, kind: null },
        ],
        board: { name: "Board", externalId: null },
        wallAngle: { value: -20, unit: null },
        climbStyle: "top-rope",
        resultStyle: "Fell/Hung",
      },
    };
    render(<ClimbingEntryBreakdown entries={[entry]} />);
    expect(screen.getByText("5.9")).toBeTruthy();
    expect(screen.getByText("Crag > Wall")).toBeTruthy();
    expect(screen.getByText("Board: Board")).toBeTruthy();
    expect(screen.getByText("Top rope")).toBeTruthy();
    expect(screen.getByText("Fell or hung")).toBeTruthy();
    expect(screen.getByText("Not sent; attempt count not recorded")).toBeTruthy();
    expect(screen.getByText("1: Fell")).toBeTruthy();
    expect(screen.getByText("Crimp")).toBeTruthy();
    expect(screen.getByText("Mountain Project")).toBeTruthy();
  });
});
