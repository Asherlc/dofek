import { describe, expect, it } from "vitest";
import { PmcEwmaCalculator } from "./pmc-ewma-calculator.ts";

function dateStringDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

describe("PmcEwmaCalculator", () => {
  it("applies exact exponential moving average formulas for chronic and acute load", () => {
    const firstDate = dateStringDaysAgo(2);
    const secondDate = dateStringDaysAgo(1);
    const thirdDate = dateStringDaysAgo(0);
    const calculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: 4,
      acuteTrainingLoadDays: 2,
    });

    const result = calculator.compute({
      dailyLoad: new Map([[firstDate, 100]]),
      queryDays: 2,
      displayDays: 2,
    });

    expect(result).toEqual([
      { date: firstDate, load: 100, ctl: 25, atl: 50, tsb: -25 },
      { date: secondDate, load: 0, ctl: 18.8, atl: 25, tsb: -6.2 },
      { date: thirdDate, load: 0, ctl: 14.1, atl: 12.5, tsb: 1.6 },
    ]);
  });

  it("trims leading display days before chronic load becomes meaningful", () => {
    const firstMeaningfulDate = dateStringDaysAgo(2);
    const calculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: 10,
      acuteTrainingLoadDays: 5,
    });

    const result = calculator.compute({
      dailyLoad: new Map([[firstMeaningfulDate, 10]]),
      queryDays: 4,
      displayDays: 4,
    });

    expect(result[0]?.date).toBe(firstMeaningfulDate);
    expect(result[0]?.ctl).toBe(1);
    expect(result).toHaveLength(3);
  });

  it("keeps a day whose rounded chronic load is exactly the meaningful threshold", () => {
    const thresholdDate = dateStringDaysAgo(0);
    const calculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: 100,
      acuteTrainingLoadDays: 50,
    });

    const result = calculator.compute({
      dailyLoad: new Map([[thresholdDate, 10]]),
      queryDays: 1,
      displayDays: 1,
    });

    expect(result).toEqual([{ date: thresholdDate, load: 10, ctl: 0.1, atl: 0.2, tsb: -0.1 }]);
  });

  it("builds rounded daily training load series with acute load responding faster than chronic load", () => {
    const activityDate = dateStringDaysAgo(1);
    const calculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
    });

    const result = calculator.compute({
      dailyLoad: new Map([[activityDate, 84]]),
      queryDays: 407,
      displayDays: 30,
    });

    const activityPoint = result.find((point) => point.date === activityDate);

    expect(activityPoint).toBeDefined();
    expect(activityPoint?.load).toBe(84);
    expect(activityPoint?.atl).toBeGreaterThan(activityPoint?.ctl ?? Number.POSITIVE_INFINITY);
    expect(activityPoint?.tsb).toBe(
      Math.round(((activityPoint?.ctl ?? 0) - (activityPoint?.atl ?? 0)) * 10) / 10,
    );
  });

  it("returns the full display window when no day reaches the meaningful chronic load threshold", () => {
    const calculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
    });

    const result = calculator.compute({
      dailyLoad: new Map(),
      queryDays: 407,
      displayDays: 30,
    });

    expect(result).toHaveLength(31);
    expect(result.every((point) => point.load === 0)).toBe(true);
    expect(result.every((point) => point.ctl === 0)).toBe(true);
    expect(result.every((point) => point.atl === 0)).toBe(true);
    expect(result.every((point) => point.tsb === 0)).toBe(true);
  });

  it("produces consecutive dates and decays chronic load on rest days", () => {
    const activityDate = dateStringDaysAgo(5);
    const calculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
    });

    const result = calculator.compute({
      dailyLoad: new Map([[activityDate, 120]]),
      queryDays: 407,
      displayDays: 30,
    });
    const activityIndex = result.findIndex((point) => point.date === activityDate);

    expect(activityIndex).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < result.length; index++) {
      const previousDate = new Date(result[index - 1]?.date ?? "invalid");
      const currentDate = new Date(result[index]?.date ?? "invalid");
      expect(currentDate.getTime() - previousDate.getTime()).toBe(86_400_000);
    }
    expect(result[activityIndex + 2]?.ctl).toBeLessThan(result[activityIndex + 1]?.ctl ?? 0);
    expect(result[activityIndex + 2]?.load).toBe(0);
  });
});
