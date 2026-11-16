import { describe, expect, it } from "vitest";
import {
  storeWithRows,
  activityMetricWindow as window,
} from "./activity-metric-source-test-helpers.ts";
import { getActivityPowerWork } from "./activity-power-work.ts";

describe("activity power work", () => {
  it("integrates fully covered power seconds while preserving zero and recording gaps", async () => {
    const result = await getActivityPowerWork(
      storeWithRows([
        { elapsed_seconds: 0, power: 200 },
        { elapsed_seconds: 1, power: 0 },
        { elapsed_seconds: 2, power: 300 },
        { elapsed_seconds: 10, power: 100 },
        { elapsed_seconds: 11, power: 100 },
      ]),
      { ...window, endedAt: "2026-10-20T12:00:12.000Z" },
      "wahoo",
    );
    expect(result).toEqual({
      workKilojoules: 0.7,
      coverage: { coveredSeconds: 5, coveragePct: 41.7 },
    });
  });

  it("returns recorded zero work for all-zero power", async () => {
    expect(
      await getActivityPowerWork(storeWithRows([{ elapsed_seconds: 0, power: 0 }]), {
        ...window,
        endedAt: "2026-10-20T12:00:01.000Z",
      }),
    ).toEqual({ workKilojoules: 0, coverage: { coveredSeconds: 1, coveragePct: 100 } });
  });

  it("returns unavailable work when no valid power was recorded", async () => {
    expect(await getActivityPowerWork(storeWithRows([]), window)).toEqual({
      workKilojoules: null,
      coverage: { coveredSeconds: 0, coveragePct: 0 },
    });
  });

  it("does not query power for a zero-length activity window", async () => {
    const store = storeWithRows([{ elapsed_seconds: 0, power: 200 }]);

    const result = await getActivityPowerWork(store, {
      ...window,
      endedAt: window.startedAt,
    });

    expect(result).toEqual({
      workKilojoules: null,
      coverage: { coveredSeconds: 0, coveragePct: 0 },
    });
    expect(store.query).not.toHaveBeenCalled();
  });

  it("returns missing power across a huge empty recorded window", async () => {
    expect(
      await getActivityPowerWork(storeWithRows([]), {
        ...window,
        endedAt: "2400-10-20T12:00:00.000Z",
      }),
    ).toEqual({ workKilojoules: null, coverage: { coveredSeconds: 0, coveragePct: 0 } });
  });

  it("keeps sparse measured work in a huge recorded window", async () => {
    expect(
      await getActivityPowerWork(
        storeWithRows([
          { elapsed_seconds: 0, power: 200 },
          { elapsed_seconds: 1, power: 0 },
        ]),
        { ...window, endedAt: "2400-10-20T12:00:00.000Z" },
      ),
    ).toEqual({ workKilojoules: 0.2, coverage: { coveredSeconds: 2, coveragePct: 0 } });
  });

  it("keeps native sparse coverage for a multi-day ride", async () => {
    expect(
      await getActivityPowerWork(
        storeWithRows([
          { elapsed_seconds: 0, power: 200 },
          { elapsed_seconds: 86_400, power: 300 },
        ]),
        { ...window, endedAt: "2026-10-23T12:00:00.000Z" },
      ),
    ).toEqual({ workKilojoules: 5, coverage: { coveredSeconds: 20, coveragePct: 0 } });
  });

  it("returns unavailable work when the activity has no recorded end", async () => {
    expect(
      await getActivityPowerWork(storeWithRows([{ elapsed_seconds: 0, power: 200 }]), {
        ...window,
        endedAt: null,
      }),
    ).toEqual({ workKilojoules: null, coverage: { coveredSeconds: 0, coveragePct: 0 } });
  });
});
