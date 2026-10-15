import { describe, expect, it } from "vitest";
import { climbingFiltersSchema } from "./climbing-filters.ts";

describe("climbing filters", () => {
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
