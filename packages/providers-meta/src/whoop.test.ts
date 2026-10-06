import { describe, expect, it } from "vitest";
import {
  parseWhoopWearLocation,
  WHOOP_WEAR_LOCATION_SETTING_KEY,
  WHOOP_WEAR_LOCATIONS,
} from "./whoop.ts";

describe("WHOOP wear locations", () => {
  it("exports the settings key", () => {
    expect(WHOOP_WEAR_LOCATION_SETTING_KEY).toBe("whoop.wearLocation");
  });

  it("has all five body locations", () => {
    expect(WHOOP_WEAR_LOCATIONS).toHaveLength(5);
    const ids = WHOOP_WEAR_LOCATIONS.map((location) => location.id);
    expect(ids).toEqual(["wrist", "bicep", "chest", "waist", "calf"]);
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
