import { describe, expect, it } from "vitest";
import {
  climbingContextPreset,
  climbingFiltersSchema,
  selectClimbingContext,
} from "./climbing-filters.ts";

describe("climbing filters", () => {
  it("changes climbing context without clearing setting or independent facts", () => {
    const filters = {
      setting: "outdoor",
      solo: false,
      protectionUsed: "trad",
      climbKind: "boulder",
      ropeMethod: "unroped",
    } as const;
    expect(selectClimbingContext(filters, "lead")).toEqual({
      setting: "outdoor",
      solo: false,
      protectionUsed: "trad",
      climbKind: "route",
      ropeMethod: "lead",
    });
    expect(selectClimbingContext(filters, "bouldering")).toEqual({
      setting: "outdoor",
      solo: false,
      protectionUsed: "trad",
      climbKind: "boulder",
    });
    expect(selectClimbingContext(filters, "all")).toEqual({
      setting: "outdoor",
      solo: false,
      protectionUsed: "trad",
    });
    expect(selectClimbingContext({}, "top_rope")).toEqual({
      climbKind: "route",
      ropeMethod: "top_rope",
    });
  });
  it("recognizes primary selections without mislabeling advanced climb contexts", () => {
    expect(climbingContextPreset({ setting: "unknown" })).toBe("all");
    expect(climbingContextPreset({ climbKind: "boulder" })).toBe("bouldering");
    expect(climbingContextPreset({ climbKind: "route", ropeMethod: "lead" })).toBe("lead");
    expect(climbingContextPreset({ climbKind: "route", ropeMethod: "top_rope" })).toBe("top_rope");
    expect(climbingContextPreset({ ropeMethod: "lead" })).toBeNull();
    expect(climbingContextPreset({ climbKind: "boulder", ropeMethod: "lead" })).toBeNull();
    expect(climbingContextPreset({ climbKind: "route", ropeMethod: "follow" })).toBeNull();
  });
  it("retains independent target discipline scope and attempt facts", () => {
    const filters = {
      climbKind: "route",
      discipline: "rock_climbing",
      attemptScope: "pitch",
      ropeMethod: "lead",
      solo: true,
      protectionUsed: "trad",
      routeProtection: "sport",
      setting: "outdoor",
    };
    expect(climbingFiltersSchema.parse(filters)).toEqual(filters);
  });
  it("represents unknown facts explicitly", () => {
    expect(
      climbingFiltersSchema.parse({
        ropeMethod: "unknown",
        solo: null,
        protectionUsed: "unknown",
        setting: "unknown",
      }),
    ).toEqual({ ropeMethod: "unknown", solo: null, protectionUsed: "unknown", setting: "unknown" });
  });
  it("rejects unsupported factual values", () => {
    expect(climbingFiltersSchema.safeParse({ attemptScope: "route" }).success).toBe(false);
    expect(climbingFiltersSchema.safeParse({ solo: "yes" }).success).toBe(false);
  });
});
