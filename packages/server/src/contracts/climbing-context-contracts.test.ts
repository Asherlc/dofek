import { describe, expect, it } from "vitest";
import {
  climbingActivityEntryDetailSchema,
  climbingEntrySuggestionSchema,
} from "./climbing-context-contracts.ts";

const context = {
  providerId: "openbeta",
  locationPath: ["Country", "State", "Region", "Park", "Crag", "Wall"].map((name) => ({
    name,
    externalId: null,
    kind: null,
  })),
  board: { name: "Training Board", externalId: "board-1" },
  wallAngle: { value: -20, unit: null },
  climbStyle: "top-rope",
  resultStyle: "Fell/Hung",
};
const entry = {
  id: "00000000-0000-4000-8000-000000000001",
  climbType: "route",
  gradeSystem: "yds",
  grade: "5.9",
  sent: false,
  attemptCount: null,
  attempts: [],
  ascentType: null,
  holdType: null,
  routeName: "Corner",
  locationName: "Country > State > Region > Park > Crag > Wall",
  lead: false,
  sourceName: "OpenBeta",
  sourceLinks: [],
  wallAngleDegrees: null,
  context,
};
describe("climbing context response contracts", () => {
  it("retains provider-attributed route and public tick-list destinations on both responses", () => {
    const sourceLinks = [
      {
        providerId: "mountain-project",
        kind: "route",
        url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
      },
      { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
    ];
    expect(climbingActivityEntryDetailSchema.parse({ ...entry, sourceLinks }).sourceLinks).toEqual(
      sourceLinks,
    );
    expect(
      climbingEntrySuggestionSchema.parse({ ...entry, providerId: "openbeta", sourceLinks })
        .sourceLinks,
    ).toEqual(sourceLinks);
  });
  it.each(["javascript:alert(1)", "http://www.mountainproject.com/route/105734732/swiss-cheese"])(
    "rejects unsafe serving URLs: %s",
    (url) => {
      const sourceLinks = [{ providerId: "mountain-project", kind: "route", url }];
      expect(climbingActivityEntryDetailSchema.safeParse({ ...entry, sourceLinks }).success).toBe(
        false,
      );
      expect(
        climbingEntrySuggestionSchema.safeParse({ ...entry, providerId: "openbeta", sourceLinks })
          .success,
      ).toBe(false);
    },
  );
  it("retains the complete context on details and suggestions", () => {
    expect(climbingActivityEntryDetailSchema.parse(entry).context).toEqual(context);
    expect(
      climbingEntrySuggestionSchema.parse({ ...entry, providerId: "openbeta" }).context,
    ).toEqual(context);
  });
  it.each([
    {},
    { ...context, providerId: "" },
    { ...context, wallAngle: { value: 91, unit: "degrees" } },
  ])("rejects malformed serving context %j", (invalid) => {
    expect(
      climbingActivityEntryDetailSchema.safeParse({ ...entry, context: invalid }).success,
    ).toBe(false);
    expect(
      climbingEntrySuggestionSchema.safeParse({
        ...entry,
        providerId: "openbeta",
        context: invalid,
      }).success,
    ).toBe(false);
  });
});
