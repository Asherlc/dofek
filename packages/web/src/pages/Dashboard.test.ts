import { describe, expect, it } from "vitest";
import { DASHBOARD_SECTION_IDS } from "./Dashboard";

describe("DASHBOARD_SECTION_IDS", () => {
  it("includes spo2Temp section", () => {
    expect(DASHBOARD_SECTION_IDS.has("spo2Temp")).toBe(true);
  });

  it("includes steps section", () => {
    expect(DASHBOARD_SECTION_IDS.has("steps")).toBe(true);
  });
});
