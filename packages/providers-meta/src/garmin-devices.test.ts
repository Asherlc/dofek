import { describe, expect, it } from "vitest";
import { garminDeviceThumbnail } from "./garmin-devices.ts";

const forerunner965 = "https://res.garmin.com/en/products/010-02809-00/v/c1_01_md.png";
const edge1050 = "https://res.garmin.com/en/products/010-02890-00/v/c1_01_md.png";
const fenix8Large = "https://res.garmin.com/en/products/010-02905-00/v/c1_01_md.png";

describe("garminDeviceThumbnail", () => {
  it.each([
    ["Forerunner 965", forerunner965],
    ["Edge 1050", edge1050],
    ["  GARMIN  Forerunner® 965™ ", forerunner965],
    ["Garmin fēnix® 8 – AMOLED (47 mm / 51 mm)", fenix8Large],
    ["fēnix 8 – 47mm", fenix8Large],
    ["fenix 8 - 51 mm", fenix8Large],
    ["fēnix 8 AMOLED (51mm)", fenix8Large],
    ["fēnix 8 – 43mm", "https://res.garmin.com/en/products/010-02903-00/v/c1_01_md.png"],
    ["fēnix 8 Solar (47mm)", "https://res.garmin.com/en/products/010-02906-10/v/c1_01_md.png"],
    ["fēnix 8 Dual Power (51mm)", "https://res.garmin.com/en/products/010-02907-10/v/c1_01_md.png"],
    ["quatix 8 AMOLED (47mm)", fenix8Large],
    ["tactix 8 – 47 mm, AMOLED", "https://res.garmin.com/en/products/010-03405-00/v/c1_01_md.png"],
    ["tactix 8 – 51 mm, Solar", "https://res.garmin.com/en/products/010-03407-00/v/c1_01_md.png"],
  ])("resolves the catalog model %s", (name, imageUrl) => {
    expect(garminDeviceThumbnail(name)).toBe(imageUrl);
  });

  it.each([
    undefined,
    null,
    "",
    "Garmin",
    "Unknown watch",
    "Forerunner 965 Ultra",
    "Edge 1050 Pro",
    "fēnix 8",
    "fēnix 8 – 49mm",
    "fēnix 8 AMOLED (49mm)",
    "fēnix 8 Solar (43mm)",
    "my Garmin Forerunner 965",
  ])("keeps the logo for absent or unsupported name %s", (name) => {
    expect(garminDeviceThumbnail(name)).toBeNull();
  });

  it.each(["Elite", "Solar", "AMOLED", "Tactical"])(
    "keeps the logo when %s does not identify a specific model",
    (qualifier) => {
      expect(garminDeviceThumbnail(qualifier)).toBeNull();
      expect(garminDeviceThumbnail(`Garmin ${qualifier}`)).toBeNull();
    },
  );
});
