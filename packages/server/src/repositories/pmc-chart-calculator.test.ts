import { describe, expect, it } from "vitest";
import { PmcChartCalculator } from "./pmc-chart-calculator.ts";
import { type PmcActivityRow, PmcTrainingLoadCalculator } from "./pmc-training-load-calculator.ts";

function makeTrainingLoadCalculator(): PmcTrainingLoadCalculator {
  return new PmcTrainingLoadCalculator();
}

function makeCalculator(): PmcChartCalculator {
  return new PmcChartCalculator({
    chronicTrainingLoadDays: 42,
    acuteTrainingLoadDays: 7,
    trainingLoadCalculator: makeTrainingLoadCalculator(),
  });
}

function makeActivityRow(overrides: Partial<PmcActivityRow> = {}): PmcActivityRow {
  const date = new Date();
  date.setDate(date.getDate() - 2);

  return {
    id: "activity-1",
    date: date.toISOString().slice(0, 10),
    ...overrides,
  };
}

describe("PmcChartCalculator", () => {
  it("passes the configured chronic and acute time constants into the chart", () => {
    const calculator = new PmcChartCalculator({
      chronicTrainingLoadDays: 2,
      acuteTrainingLoadDays: 1,
      trainingLoadCalculator: makeTrainingLoadCalculator(),
    });
    const activity = makeActivityRow();
    const result = calculator.buildChart({
      currentEftp: null,
      activityRows: [activity],
      normalizedPowerRows: [{ activity_id: activity.id, power_tss: 100 }],
      queryDays: 4,
      displayDays: 4,
    });
    expect(result.data.find((point) => point.date === activity.date)).toEqual({
      date: activity.date,
      load: 100,
      ctl: 50,
      atl: 100,
      tsb: -50,
    });
  });
  it("returns an empty chart and threshold metadata when no activities are present", () => {
    expect(
      makeCalculator().buildChart({
        currentEftp: 265,
        activityRows: [],
        normalizedPowerRows: [],
        queryDays: 407,
        displayDays: 90,
      }),
    ).toEqual({
      data: [],
      unavailableReason: null,
      model: { ftp: 265 },
    });
  });

  it("treats a canonical null stress row as unknown and reports multiple unsupported activities", () => {
    const result = makeCalculator().buildChart({
      currentEftp: 190,
      activityRows: [makeActivityRow({ id: "one" }), makeActivityRow({ id: "two" })],
      normalizedPowerRows: [
        { activity_id: "one", power_tss: null },
        { activity_id: "two", power_tss: null },
      ],
      queryDays: 407,
      displayDays: 90,
    });
    expect(result.data).toEqual([]);
    expect(result.unavailableReason).toBe(
      "Training load is unavailable for 2 cycling activities: power-derived training stress is missing. Record cycling power with a usable threshold to calculate training load.",
    );
  });

  it("keeps measured zero canonical stress available without heart-rate evidence", () => {
    const activity = makeActivityRow();
    const result = makeCalculator().buildChart({
      currentEftp: null,
      activityRows: [activity],
      normalizedPowerRows: [{ activity_id: activity.id, power_tss: 0 }],
      queryDays: 407,
      displayDays: 90,
    });
    expect(result.unavailableReason).toBeNull();
    expect(result.data.find((point) => point.date === activity.date)?.load).toBe(0);
  });
  it("withholds a chart when any activity has unknown load", () => {
    const result = makeCalculator().buildChart({
      currentEftp: 190,
      activityRows: [makeActivityRow({ id: "known" }), makeActivityRow({ id: "unknown" })],
      normalizedPowerRows: [{ activity_id: "known", power_tss: 100 }],
      queryDays: 407,
      displayDays: 90,
    });
    expect(result.data).toEqual([]);
    expect(result.unavailableReason).toContain("1 cycling activity");
  });

  it("returns an unavailable chart when canonical stress is missing", () => {
    const calculator = makeCalculator();

    const result = calculator.buildChart({
      currentEftp: 190,
      activityRows: [makeActivityRow()],
      normalizedPowerRows: [],
      queryDays: 407,
      displayDays: 90,
    });

    expect(result).toEqual({
      data: [],
      unavailableReason:
        "Training load is unavailable for 1 cycling activity: power-derived training stress is missing. Record cycling power with a usable threshold to calculate training load.",
      model: { ftp: 190 },
    });
  });

  it("builds a power-only chart from canonical per-activity stress", () => {
    const calculator = makeCalculator();

    const result = calculator.buildChart({
      currentEftp: 190,
      activityRows: [
        makeActivityRow({
          id: "power-activity",
        }),
      ],
      normalizedPowerRows: [{ activity_id: "power-activity", power_tss: 125 }],
      queryDays: 407,
      displayDays: 90,
    });

    expect(result.model.ftp).toBe(190);
    expect(result.data.length).toBeGreaterThan(0);
  });
});
