import { describe, expect, it } from "vitest";
import { climbingBoardSchema, climbingWallAngleSchema } from "./climbing-experience.ts";

describe("recorded climbing experience", () => {
  it("preserves named boards with nullable source identity", () => {
    expect(climbingBoardSchema.parse({ name: "  Kilter Board ", externalId: null })).toEqual({
      name: "Kilter Board",
      externalId: null,
    });
    expect(climbingBoardSchema.safeParse({ name: " ", externalId: null }).success).toBe(false);
  });

  it("validates known degree angles independently of unknown source units", () => {
    expect(climbingWallAngleSchema.parse({ value: 0, unit: "degrees" })).toEqual({
      value: 0,
      unit: "degrees",
    });
    expect(climbingWallAngleSchema.parse({ value: 120, unit: null })).toEqual({
      value: 120,
      unit: null,
    });
    expect(climbingWallAngleSchema.safeParse({ value: 90.1, unit: "degrees" }).success).toBe(false);
    expect(climbingWallAngleSchema.safeParse({ value: -90.1, unit: "degrees" }).success).toBe(
      false,
    );
    expect(climbingWallAngleSchema.safeParse({ value: Number.NaN, unit: null }).success).toBe(
      false,
    );
  });
});
