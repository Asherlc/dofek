import { describe, expect, it } from "vitest";
import { mapSportId, mapV2ActivityType } from "./sports.ts";

describe("WHOOP sport mapping", () => {
  it("maps official and BFF commute classifications to cycling", () => {
    expect(mapSportId(89)).toBe("cycling");
    expect(mapV2ActivityType("commuting")).toBe("cycling");
  });
});
