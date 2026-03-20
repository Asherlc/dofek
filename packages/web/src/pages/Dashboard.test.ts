import { describe, expect, it } from "vitest";
import { DASHBOARD_SECTION_IDS } from "./Dashboard";

describe("DASHBOARD_SECTION_IDS", () => {
  it("includes spo2Temp section", () => {
    expect(DASHBOARD_SECTION_IDS.has("spo2Temp")).toBe(true);
  });

  it("includes steps section", () => {
    expect(DASHBOARD_SECTION_IDS.has("steps")).toBe(true);
  });

  it("includes sleep section", () => {
    expect(DASHBOARD_SECTION_IDS.has("sleep")).toBe(true);
  });

  it("includes weeklyReport section", () => {
    expect(DASHBOARD_SECTION_IDS.has("weeklyReport")).toBe(true);
  });

  it("includes sleepNeed section (paired with weeklyReport)", () => {
    expect(DASHBOARD_SECTION_IDS.has("sleepNeed")).toBe(true);
  });
});
