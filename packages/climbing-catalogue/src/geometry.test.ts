import { beforeEach, describe, expect, it, vi } from "vitest";

describe("catalogue geometry", () => {
  beforeEach(() => vi.resetModules());
  it.each([
    { latitude: 0, longitude: 0 },
    { latitude: 90, longitude: 180 },
    { latitude: -90, longitude: -180 },
    { latitude: 37.5, longitude: -122.25 },
  ])("retains boundary coordinates: %o", async (coordinates) => {
    const { gpsCoordinatesSchema } = await import("./geometry.ts");
    expect(gpsCoordinatesSchema.parse(coordinates)).toEqual(coordinates);
  });

  it.each([
    { latitude: 0 },
    { longitude: 0 },
    { latitude: null, longitude: 0 },
    { latitude: Number.NaN, longitude: 0 },
    { latitude: 0, longitude: Number.POSITIVE_INFINITY },
    { latitude: Number.NEGATIVE_INFINITY, longitude: 0 },
    { latitude: 90.01, longitude: 0 },
    { latitude: -90.01, longitude: 0 },
    { latitude: 0, longitude: 180.01 },
    { latitude: 0, longitude: -180.01 },
  ])("rejects invalid or incomplete coordinates: %o", async (coordinates) => {
    const { gpsCoordinatesSchema } = await import("./geometry.ts");
    expect(gpsCoordinatesSchema.safeParse(coordinates).success).toBe(false);
  });

  it("preserves unknown angle units without interpreting them as degrees", async () => {
    const { numericWallAngleSchema } = await import("./geometry.ts");
    expect(numericWallAngleSchema.parse({ value: 120, unit: null })).toEqual({
      value: 120,
      unit: null,
    });
    expect(numericWallAngleSchema.safeParse({ value: 120, unit: "degrees" }).success).toBe(false);
  });

  it.each([-90, 0, 90])("accepts a recorded degree angle at %s", async (value) => {
    const { numericWallAngleSchema } = await import("./geometry.ts");
    expect(numericWallAngleSchema.parse({ value, unit: "degrees" })).toEqual({
      value,
      unit: "degrees",
    });
  });

  it.each([-91, 91])("explains a recorded degree angle outside bounds at %s", async (value) => {
    const { numericWallAngleSchema } = await import("./geometry.ts");
    const result = numericWallAngleSchema.safeParse({ value, unit: "degrees" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "A recorded degree angle must be between -90 and 90.",
    );
  });
});
