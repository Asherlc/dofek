import { describe, expect, it } from "vitest";
import { appleDeviceModel, deviceDisplayName } from "./device-names.ts";

describe("appleDeviceModel", () => {
  it.each([
    ["Watch6,9", "Apple Watch Series 7 (GPS + Cellular, 45mm)"],
    ["Watch7,5", "Apple Watch Ultra 2"],
    ["Watch5,11", "Apple Watch SE (1st generation, GPS + Cellular, 40mm)"],
    ["Watch5,12", "Apple Watch SE (1st generation, GPS + Cellular, 44mm)"],
    ["iPhone16,1", "iPhone 15 Pro"],
    ["iPad1,1", "iPad"],
    ["iPad13,4", "iPad Pro 11-inch (3rd generation) Wi-Fi"],
    ["iPad14,1", "iPad mini (6th generation) Wi-Fi"],
    ["iPad13,1", "iPad Air (4th generation) Wi-Fi"],
    ["iPod9,1", "iPod touch (7th generation)"],
  ])("resolves the public model %s", (identifier, expected) => {
    expect(appleDeviceModel(identifier)).toBe(expected);
    expect(deviceDisplayName(identifier)).toBe(expected);
  });

  it.each(["Watch2,1", "Watch99,99", "iPhone99,1", "Mac14,2", "toString", "", "watch6,9"])(
    "does not claim a public Apple model for %s",
    (identifier) => {
      expect(appleDeviceModel(identifier)).toBeNull();
      expect(deviceDisplayName(identifier)).toBe(identifier);
    },
  );
});

describe("deviceDisplayName", () => {
  it.each([
    ["fr955", "Forerunner 955"],
    ["Fr955", "Forerunner 955"],
    ["edge530", "Edge 530"],
    ["Edge530", "Edge 530"],
    ["fenix8", "fēnix 8"],
    ["fenix7X", "fēnix 7X"],
    ["fr955Solar", "Forerunner 955 Solar"],
    ["forerunner_945_lte", "Forerunner 945 LTE"],
    ["edge_1040_solar", "Edge 1040 Solar"],
    ["vivoactive5", "vívoactive 5"],
    ["assiomaUno", "Assioma Uno"],
    ["assioma_duo", "Assioma Duo"],
  ])("formats the supplied Garmin symbol %s", (name, expected) => {
    expect(deviceDisplayName(name)).toBe(expected);
  });

  it.each([
    "WHOOP 4.0",
    "Garmin Edge 530",
    "fēnix 8 – 47mm",
    "COROS PACE 3",
    "Asher’s Apple Watch",
    "My custom Garmin device",
    "mysteryModel_123",
    "unknown_device",
    "1234",
  ])("preserves readable and unknown names: %s", (name) => {
    expect(deviceDisplayName(name)).toBe(name);
  });

  it("trims presentation whitespace", () => {
    expect(deviceDisplayName("  My Watch\t")).toBe("My Watch");
  });

  it("preserves long malformed model tokens", () => {
    const name = `fenix${"0".repeat(20_000)}!`;
    expect(deviceDisplayName(name)).toBe(name);
  });
});
