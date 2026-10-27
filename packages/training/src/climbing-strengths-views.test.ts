import { describe, expect, it } from "vitest";
import {
  climbingStrengthsPurpose,
  climbingStrengthsPurposeView,
} from "./climbing-strengths-views.ts";

describe("climbing strengths navigation", () => {
  it("organizes chart presentations by the question they answer", () => {
    for (const view of ["gaps", "exposure", "radar"] as const)
      expect(climbingStrengthsPurpose(view)).toBe("styles");
    for (const view of ["profile", "curves", "pyramids"] as const)
      expect(climbingStrengthsPurpose(view)).toBe("grades");
    expect(climbingStrengthsPurpose("progress")).toBe("progress");
  });
  it("opens each purpose with an appropriate default presentation", () => {
    expect(climbingStrengthsPurposeView("styles")).toBe("gaps");
    expect(climbingStrengthsPurposeView("grades")).toBe("profile");
    expect(climbingStrengthsPurposeView("progress")).toBe("progress");
  });
});
