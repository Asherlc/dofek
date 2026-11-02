import { describe, expect, it } from "vitest";
import { PmcChartCalculator } from "./pmc-chart-calculator.ts";
import {
  type PmcActivityRow,
  type PmcNormalizedPowerRow,
  PmcTrainingLoadCalculator,
} from "./pmc-training-load-calculator.ts";

function makeTrainingLoadCalculator(): PmcTrainingLoadCalculator {
  return new PmcTrainingLoadCalculator({
    computeTrainingImpulse: (durationMin, avgHr, maxHr, restingHr) => {
      if (maxHr <= restingHr || avgHr <= restingHr) return 0;
      return durationMin * ((avgHr - restingHr) / (maxHr - restingHr));
    },
    computeHeartRateTrainingStressScore: (durationMin, avgHr, maxHr, restingHr) => {
      if (maxHr <= restingHr || avgHr <= restingHr) return 0;
      return durationMin * ((avgHr - restingHr) / (maxHr - restingHr));
    },
    buildTrainingStressModel: (pairedData) =>
      pairedData.length >= 10 ? { slope: 1, intercept: 0, r2: 0.9996 } : null,
  });
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
    global_max_hr: 190,
    resting_hr: 60,
    id: "activity-1",
    date: date.toISOString().slice(0, 10),
    duration_min: 60,
    avg_hr: 150,
    max_hr: 180,
    avg_power: 200,
    power_samples: 3600,
    hr_samples: 3600,
    ...overrides,
  };
}

function makeLearnedModelInput(): {
  activityRows: PmcActivityRow[];
  normalizedPowerRows: PmcNormalizedPowerRow[];
} {
  const globalMaxHeartRate = 190;
  const restingHeartRate = 60;
  const genderFactor = 1.92;
  const exponent = 1.67;
  const activityRows: PmcActivityRow[] = [];
  const normalizedPowerRows: PmcNormalizedPowerRow[] = [];

  for (let index = 0; index < 10; index += 1) {
    const avgHeartRate = 120 + index * 5;
    const deltaHeartRateRatio =
      (avgHeartRate - restingHeartRate) / (globalMaxHeartRate - restingHeartRate);
    const trimp =
      60 * deltaHeartRateRatio * genderFactor * Math.exp(exponent * deltaHeartRateRatio);
    const powerTss = trimp * 1.25 + 4;
    const date = new Date();
    date.setDate(date.getDate() - 20 + index);
    const activityId = `learned-model-${index}`;

    activityRows.push(
      makeActivityRow({
        id: activityId,
        date: date.toISOString().slice(0, 10),
        avg_hr: avgHeartRate,
        avg_power: 200,
      }),
    );
    normalizedPowerRows.push({ activity_id: activityId, power_tss: powerTss });
  }

  return { activityRows, normalizedPowerRows };
}

describe("PmcChartCalculator", () => {
  it("passes the configured chronic and acute time constants into the chart", () => {
    const calculator = new PmcChartCalculator({
      chronicTrainingLoadDays: 2,
      acuteTrainingLoadDays: 1,
      trainingLoadCalculator: makeTrainingLoadCalculator(),
    });
    const activity = makeActivityRow({ avg_hr: null });
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
  it("returns an empty chart and generic metadata when no activities are present", () => {
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
      model: { type: "generic", pairedActivities: 0, r2: null, ftp: 265 },
    });
  });

  it.each([{ avg_hr: 0 }, { avg_hr: -1 }, { global_max_hr: 60 }, { global_max_hr: 50 }])(
    "withholds HR fallback when heart-rate evidence is unusable %j",
    (overrides) => {
      const result = makeCalculator().buildChart({
        currentEftp: null,
        activityRows: [makeActivityRow(overrides)],
        normalizedPowerRows: [],
        queryDays: 407,
        displayDays: 90,
      });
      expect(result.data).toEqual([]);
      expect(result.unavailableReason).toContain("1 cycling activity");
    },
  );

  it("treats a canonical null stress row as unknown and reports multiple unsupported activities", () => {
    const result = makeCalculator().buildChart({
      currentEftp: 190,
      activityRows: [
        makeActivityRow({ id: "one", avg_hr: null }),
        makeActivityRow({ id: "two", avg_hr: null }),
      ],
      normalizedPowerRows: [
        { activity_id: "one", power_tss: null },
        { activity_id: "two", power_tss: null },
      ],
      queryDays: 407,
      displayDays: 90,
    });
    expect(result.data).toEqual([]);
    expect(result.unavailableReason).toBe(
      "Training load is unavailable for 2 cycling activities: computed power stress and usable heart-rate data are missing.",
    );
  });

  it("keeps measured zero canonical stress available without heart-rate evidence", () => {
    const activity = makeActivityRow({ avg_hr: null, global_max_hr: null });
    const result = makeCalculator().buildChart({
      currentEftp: null,
      activityRows: [activity],
      normalizedPowerRows: [{ activity_id: activity.id, power_tss: 0 }],
      queryDays: 407,
      displayDays: 90,
    });
    expect(result.unavailableReason).toBeNull();
    expect(result.data.find((point) => point.date === activity.date)?.load).toBe(0);
    expect(result.model.pairedActivities).toBe(0);
  });
  it("withholds a chart when any activity has unknown load", () => {
    const result = makeCalculator().buildChart({
      currentEftp: 190,
      activityRows: [
        makeActivityRow({ id: "known" }),
        makeActivityRow({ id: "unknown", avg_hr: null }),
      ],
      normalizedPowerRows: [{ activity_id: "known", power_tss: 100 }],
      queryDays: 407,
      displayDays: 90,
    });
    expect(result.data).toEqual([]);
    expect(result.unavailableReason).toContain("1 cycling activity");
  });

  it("returns the generic empty model when there is no global max heart rate", () => {
    const calculator = makeCalculator();

    const result = calculator.buildChart({
      currentEftp: 190,
      activityRows: [makeActivityRow({ global_max_hr: null })],
      normalizedPowerRows: [],
      queryDays: 407,
      displayDays: 90,
    });

    expect(result).toEqual({
      data: [],
      unavailableReason:
        "Training load is unavailable for 1 cycling activity: computed power stress and usable heart-rate data are missing.",
      model: { type: "generic", pairedActivities: 0, r2: null, ftp: 190 },
    });
  });

  it("builds a power-only chart from canonical per-activity stress", () => {
    const calculator = makeCalculator();

    const result = calculator.buildChart({
      currentEftp: 190,
      activityRows: [
        makeActivityRow({
          id: "power-activity",
          avg_power: 200,
          avg_hr: null,
          global_max_hr: null,
        }),
      ],
      normalizedPowerRows: [{ activity_id: "power-activity", power_tss: 125 }],
      queryDays: 407,
      displayDays: 90,
    });

    expect(result.model.ftp).toBe(190);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("returns rounded learned model metadata when enough paired activities fit", () => {
    const calculator = makeCalculator();
    const { activityRows, normalizedPowerRows } = makeLearnedModelInput();

    const result = calculator.buildChart({
      currentEftp: 190,
      activityRows,
      normalizedPowerRows,
      queryDays: 407,
      displayDays: 90,
    });

    expect(result.model).toEqual({
      type: "learned",
      pairedActivities: 10,
      r2: 1,
      ftp: 190,
    });
  });

  it("uses resting heart rate from activity rows when calculating load", () => {
    const lowRestingCalculator = makeCalculator();
    const highRestingCalculator = makeCalculator();

    const lowRestingResult = lowRestingCalculator.buildChart({
      currentEftp: null,
      activityRows: [makeActivityRow({ avg_power: null, power_samples: 0, resting_hr: 40 })],
      normalizedPowerRows: [],
      queryDays: 407,
      displayDays: 90,
    });
    const highRestingResult = highRestingCalculator.buildChart({
      currentEftp: null,
      activityRows: [makeActivityRow({ avg_power: null, power_samples: 0, resting_hr: 80 })],
      normalizedPowerRows: [],
      queryDays: 407,
      displayDays: 90,
    });

    const activityDate = lowRestingResult.data.find((point) => point.load > 0)?.date;
    const lowRestingLoad =
      lowRestingResult.data.find((point) => point.date === activityDate)?.load ?? 0;
    const highRestingLoad =
      highRestingResult.data.find((point) => point.date === activityDate)?.load ?? 0;

    expect(lowRestingLoad).toBeGreaterThan(0);
    expect(highRestingLoad).toBeGreaterThan(0);
    expect(lowRestingLoad).not.toBe(highRestingLoad);
  });
});
