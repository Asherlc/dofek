import { describe, expect, it } from "vitest";
import {
  storeWithRows,
  activityMetricWindow as window,
} from "./activity-metric-source-test-helpers.ts";
import { getActivitySourceHrZones } from "./activity-source-hr-zones.ts";

describe("selected-source heart-rate zones", () => {
  it("maps source-specific zone counts into the same zone contract as default HR", async () => {
    const zones = await getActivitySourceHrZones(
      storeWithRows([{ zone0: 0, zone1: 10, zone2: 30, zone3: 0, zone4: 0, zone5: 0 }]),
      window,
      "garmin",
    );
    expect(zones.find((zone) => zone.zone === 2)).toMatchObject({ seconds: 30, percent: 75 });
  });

  it("uses the interpolated median for an even number of resting-HR baselines", async () => {
    const store = storeWithRows([]);
    await getActivitySourceHrZones(store, window, "garmin");
    const query = store.query.mock.calls[0]?.[1];
    expect(query).toContain("quantileExactInclusive(0.5)");
    expect(query).toContain("effective_resting_hr");
    expect(query).toContain("scalar < effective_resting_hr + (max_hr - effective_resting_hr)");
  });

  it("returns zeroed zones when the selected-source query has no profile row", async () => {
    const zones = await getActivitySourceHrZones(storeWithRows([]), window, "garmin");

    expect(zones).toHaveLength(6);
    expect(zones.every((zone) => zone.seconds === 0 && zone.percent === 0)).toBe(true);
  });
});
