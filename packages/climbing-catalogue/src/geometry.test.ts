import { describe, expect, it } from "vitest";
import { gpsCoordinatesSchema, numericWallAngleSchema } from "./geometry.ts";

describe("catalogue geometry", () => {
  it.each([
    { latitude: 90, longitude: 180 },
    { latitude: -90, longitude: -180 },
  ])("retains boundary coordinates: %o", (coordinates) => {
    expect(gpsCoordinatesSchema.parse(coordinates)).toEqual(coordinates);
  });

  it.each([
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
    { latitude: Number.NaN, longitude: 0 },
    { latitude: 0 },
  ])("rejects invalid or incomplete coordinates: %o", (coordinates) => {
    expect(gpsCoordinatesSchema.safeParse(coordinates).success).toBe(false);
  });

  it("preserves unknown angle units without interpreting them as degrees", () => {
    expect(numericWallAngleSchema.parse({ value: 120, unit: null })).toEqual({
      value: 120,
      unit: null,
    });
    expect(numericWallAngleSchema.safeParse({ value: 120, unit: "degrees" }).success).toBe(false);
  });
});
