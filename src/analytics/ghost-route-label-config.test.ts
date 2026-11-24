import { describe, expect, it } from "vitest";
import {
  readGhostMapLabelsRegion,
  readGhostRouteLabelsWorkerConfig,
} from "./ghost-route-label-config.ts";

describe("Ghost route label configuration", () => {
  it.each([undefined, "disabled"])("is off when the region is %s", (region) => {
    expect(readGhostMapLabelsRegion(region)).toBeUndefined();
    expect(readGhostRouteLabelsWorkerConfig({ GHOST_MAP_LABELS_REGION: region })).toBeUndefined();
  });

  it.each(["eu", "global"])("configures %s with a 24-hour retention limit", (region) => {
    expect(readGhostMapLabelsRegion(region)).toBe(region);
    expect(
      readGhostRouteLabelsWorkerConfig({
        GHOST_MAP_LABELS_REGION: region,
        GEOAPIFY_API_KEY: "  example-key  ",
      }),
    ).toEqual({ provider: { region, apiKey: "example-key" }, resultTtlMs: 86_400_000 });
  });

  it.each(["us", "", "EU"])("rejects the explicit region %j with its key name", (region) => {
    expect(() => readGhostMapLabelsRegion(region)).toThrow("GHOST_MAP_LABELS_REGION");
  });

  it.each([undefined, "", "  "])("rejects an enabled worker with a key of %j", (apiKey) => {
    expect(() =>
      readGhostRouteLabelsWorkerConfig({
        GHOST_MAP_LABELS_REGION: "eu",
        GEOAPIFY_API_KEY: apiKey,
      }),
    ).toThrow("GEOAPIFY_API_KEY");
  });
});
