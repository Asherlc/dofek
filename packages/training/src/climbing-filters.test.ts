import { describe, expect, it } from "vitest";
import {
  climbingFilterSummary,
  climbingFiltersSchema,
  toggleClimbingSetting,
  toggleClimbingType,
} from "./climbing-filters.ts";

describe("climbing filters", () => {
  it.each(["indoor", "outdoor", "unknown"])(
    "normalizes a single %s setting from existing clients",
    (setting) => {
      expect(climbingFiltersSchema.parse({ setting })).toEqual({ setting: [setting] });
    },
  );
  it("retains independent target discipline scope and attempt facts", () => {
    const filters = {
      climbKind: "route",
      discipline: "rock_climbing",
      attemptScope: "pitch",
      ropeMethod: "lead",
      solo: true,
      protectionUsed: "trad",
      routeProtection: "sport",
      setting: ["outdoor"],
    };
    expect(climbingFiltersSchema.parse(filters)).toEqual(filters);
  });
  it("represents unknown facts explicitly", () => {
    expect(
      climbingFiltersSchema.parse({
        ropeMethod: "unknown",
        solo: null,
        protectionUsed: "unknown",
        setting: ["unknown"],
      }),
    ).toEqual({
      ropeMethod: "unknown",
      solo: null,
      protectionUsed: "unknown",
      setting: ["unknown"],
    });
  });
  it("rejects unsupported factual values", () => {
    expect(climbingFiltersSchema.safeParse({ attemptScope: "route" }).success).toBe(false);
    expect(climbingFiltersSchema.safeParse({ solo: "yes" }).success).toBe(false);
    expect(climbingFiltersSchema.safeParse({ setting: Array(4).fill("indoor") }).success).toBe(
      false,
    );
    expect(climbingFiltersSchema.safeParse({ types: Array(4).fill("lead") }).success).toBe(false);
  });
});

it("validates multi-setting filters and toggles them without changing other facts", () => {
  expect(climbingFiltersSchema.parse({ setting: ["indoor", "unknown"] })).toEqual({
    setting: ["indoor", "unknown"],
  });
  expect(climbingFiltersSchema.parse({ setting: [] })).toEqual({ setting: [] });
  expect(climbingFiltersSchema.safeParse({ setting: ["virtual"] }).success).toBe(false);
  expect(toggleClimbingSetting({ solo: false }, "unknown")).toEqual({
    solo: false,
    setting: ["indoor", "outdoor"],
  });
  expect(toggleClimbingSetting({ setting: ["indoor", "outdoor"] }, "unknown")).toEqual({});
  expect(toggleClimbingSetting({}, "all")).toEqual({ setting: [] });
  expect(toggleClimbingSetting({ setting: [] }, "all")).toEqual({});
  expect(toggleClimbingSetting({ setting: ["outdoor"] }, "outdoor")).toEqual({ setting: [] });
});

it("toggles climbing types independently and summarizes both groups", () => {
  expect(toggleClimbingType({ setting: ["indoor"] }, "top_rope")).toEqual({
    setting: ["indoor"],
    types: ["bouldering", "lead"],
  });
  expect(toggleClimbingType({ types: ["bouldering", "lead"] }, "top_rope")).toEqual({});
  expect(toggleClimbingType({}, "all")).toEqual({ types: [] });
  expect(toggleClimbingType({ types: [] }, "all")).toEqual({});
  expect(climbingFilterSummary({ types: ["bouldering", "lead"], setting: ["indoor"] })).toBe(
    "Bouldering + Lead · Indoor",
  );
  expect(climbingFilterSummary({ types: [], setting: [] })).toBe("No climbing types · No settings");
  expect(climbingFilterSummary({})).toBe("All climbing · All settings");
  expect(climbingFilterSummary({ setting: ["outdoor"] })).toBe("All climbing · Outdoor");
  expect(climbingFilterSummary({ types: ["lead"] })).toBe("Lead · All settings");
});
