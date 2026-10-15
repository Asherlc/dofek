import { describe, expect, it } from "vitest";
import { gpsCoordinatesSchema } from "./gps-coordinates.ts";

describe("gpsCoordinatesSchema", () => {
  it.each([
    { latitude: 0, longitude: 0 },
    { latitude: -90, longitude: -180 },
    { latitude: 90, longitude: 180 },
    { latitude: 37.5, longitude: -122.25 },
  ])("accepts zero and signed boundary coordinates: %j", (coordinates) => {
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
  ])("rejects incomplete nonfinite and out-of-range pairs: %j", (coordinates) => {
    expect(gpsCoordinatesSchema.safeParse(coordinates).success).toBe(false);
  });
});
