/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { climbingActivityEntryDetailSchema } from "../../../../../server/src/contracts/climbing-context-contracts.ts";
import { ClimbingEntryBreakdown } from "./ClimbingEntryBreakdown.tsx";

describe("ClimbingEntryBreakdown", () => {
  it.each(["Onsight", "Flash", "Redpoint"] as const)(
    "uses the %s badge to communicate a successful ascent",
    (ascentType) => {
      const entry = climbingActivityEntryDetailSchema.parse({
        id: "entry-1",
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.6",
        sent: true,
        attemptCount: ascentType === "Redpoint" ? 7 : null,
        attempts: [],
        ascentType,
        holdType: null,
        routeName: "Left Arete",
        locationName: "Kombucha Crag",
        lead: true,
        sourceName: "Mountain Project",
        wallAngleDegrees: null,
        context: {
          providerId: "mountain-project",
          locationPath: [{ name: "Kombucha Crag", externalId: null, kind: null }],
          board: null,
          wallAngle: null,
          climbStyle: "lead",
          resultStyle: ascentType,
        },
      });
      render(<ClimbingEntryBreakdown entries={[entry]} />);
      expect(screen.getByText("5.6")).toBeTruthy();
      expect(screen.getByText(ascentType)).toBeTruthy();
      if (ascentType === "Redpoint") {
        expect(screen.getByText("7 attempts")).toBeTruthy();
      } else {
        expect(screen.queryByText(/attempt|\bSent\b/i)).toBeNull();
      }
    },
  );

  it("combines recorded context with unknown counts and individual attempts", () => {
    const entry = climbingActivityEntryDetailSchema.parse({
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
    });
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
