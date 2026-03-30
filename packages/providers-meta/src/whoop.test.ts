import { describe, expect, it } from "vitest";
import {
  parseWhoopWearLocation,
  WHOOP_WEAR_LOCATIONS,
  whoopWearLocationDescription,
  whoopWearLocationLabel,
} from "./whoop.ts";

describe("WHOOP wear locations", () => {
  it("has all five body locations", () => {
    expect(WHOOP_WEAR_LOCATIONS).toHaveLength(5);
    const ids = WHOOP_WEAR_LOCATIONS.map((location) => location.id);
    expect(ids).toEqual(["wrist", "bicep", "chest", "waist", "calf"]);
  });

  it("returns a human-readable label for each location", () => {
    expect(whoopWearLocationLabel("wrist")).toBe("Wrist");
    expect(whoopWearLocationLabel("bicep")).toBe("Bicep / Upper Arm");
    expect(whoopWearLocationLabel("chest")).toBe("Chest / Torso");
    expect(whoopWearLocationLabel("waist")).toBe("Waist / Waistband");
    expect(whoopWearLocationLabel("calf")).toBe("Lower Leg / Calf");
  });

  it("returns a description for each location", () => {
    const lower = (id: "wrist" | "bicep" | "chest" | "waist" | "calf") =>
      whoopWearLocationDescription(id).toLowerCase();
    expect(lower("wrist")).toContain("band");
    expect(lower("bicep")).toContain("bicep");
    expect(lower("chest")).toContain("sports bra");
    expect(lower("waist")).toContain("boxers");
    expect(lower("calf")).toContain("leggings");
  });

  it("parses valid wear locations", () => {
    expect(parseWhoopWearLocation("wrist")).toBe("wrist");
    expect(parseWhoopWearLocation("bicep")).toBe("bicep");
    expect(parseWhoopWearLocation("chest")).toBe("chest");
    expect(parseWhoopWearLocation("waist")).toBe("waist");
    expect(parseWhoopWearLocation("calf")).toBe("calf");
  });

  it("defaults to wrist for invalid values", () => {
    expect(parseWhoopWearLocation("unknown")).toBe("wrist");
    expect(parseWhoopWearLocation(null)).toBe("wrist");
    expect(parseWhoopWearLocation(undefined)).toBe("wrist");
    expect(parseWhoopWearLocation(42)).toBe("wrist");
  });
});
