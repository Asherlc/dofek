import { describe, expect, it } from "vitest";
import { formatPlannedIntervals, type PlannedIntervalInput } from "./planned-interval.ts";

function row(overrides: Partial<PlannedIntervalInput>): PlannedIntervalInput {
  return {
    intervalIndex: 0,
    startOffsetSeconds: 0,
    endOffsetSeconds: 180,
    label: "Work 1",
    target: { kind: "range", minWatts: 250, maxWatts: 265 },
    plannedDurationSeconds: 180,
    recordedTimerDurationSeconds: 180,
    timerDifferenceSeconds: 0,
    averagePowerWatts: 256,
    ...overrides,
  };
}

describe("formatPlannedIntervals", () => {
  it("formats a planned range against the observed average", () => {
    const [work] = formatPlannedIntervals([row({})]);
    expect(work).toMatchObject({
      name: "Work 1",
      recordedPower: "256 W recorded",
      plannedPower: "250–265 W planned",
      timer: "3:00",
      timerDetail: "3:00 planned",
      timerTone: "on-plan",
    });
  });

  it("formats a point target", () => {
    const [work] = formatPlannedIntervals([row({ target: { kind: "point", watts: 260 } })]);
    expect(work?.plannedPower).toBe("260 W planned");
  });

  it("describes a short recorded timer from the signed server difference", () => {
    const [work] = formatPlannedIntervals([
      row({ recordedTimerDurationSeconds: 134, timerDifferenceSeconds: -46 }),
    ]);
    expect(work).toMatchObject({
      timer: "2:14",
      timerDetail: "0:46 short of 3:00",
      timerTone: "short",
    });
  });

  it("describes a long recorded timer", () => {
    const [work] = formatPlannedIntervals([
      row({ recordedTimerDurationSeconds: 195, timerDifferenceSeconds: 15 }),
    ]);
    expect(work).toMatchObject({ timerDetail: "0:15 longer than 3:00", timerTone: "long" });
  });

  it("keeps missing power and missing timer unavailable, and a recorded zero as 0 W", () => {
    const [missing, zero] = formatPlannedIntervals([
      row({
        averagePowerWatts: null,
        recordedTimerDurationSeconds: null,
        timerDifferenceSeconds: null,
      }),
      row({ intervalIndex: 1, label: null, averagePowerWatts: 0 }),
    ]);
    expect(missing).toMatchObject({
      recordedPower: "Power unavailable",
      timer: "Timer unavailable",
      timerDetail: "3:00 planned",
      actualPosition: null,
    });
    expect(zero).toMatchObject({ name: "Interval 2", recordedPower: "0 W recorded" });
    expect(zero?.actualPosition).not.toBeNull();
  });

  it("places marks on one shared scale spanning plan and observed power", () => {
    const rows = formatPlannedIntervals([
      row({ averagePowerWatts: 240 }),
      row({ intervalIndex: 1, target: { kind: "point", watts: 260 }, averagePowerWatts: 280 }),
    ]);
    expect(rows[0]?.targetStart).toBeLessThan(rows[1]?.targetStart ?? 0);
    for (const item of rows) {
      for (const value of [item.targetStart, item.targetWidth, item.actualPosition]) {
        expect(value === null || (value >= 0 && value <= 100)).toBe(true);
      }
    }
    expect(rows[1]?.actualPosition).toBe(100);
  });

  it("pads a degenerate single-watt scale with nonnegative extent and centers the point", () => {
    const [work] = formatPlannedIntervals([
      row({ target: { kind: "point", watts: 260 }, averagePowerWatts: 260 }),
    ]);
    expect(work).toMatchObject({
      scaleMinWatts: 255,
      scaleMaxWatts: 265,
      targetStart: 50,
      targetWidth: 0,
      actualPosition: 50,
      isPoint: true,
    });
    const [low] = formatPlannedIntervals([
      row({ target: { kind: "point", watts: 2 }, averagePowerWatts: 2 }),
    ]);
    expect(low?.scaleMinWatts).toBe(0);
    expect(low?.scaleMaxWatts).toBeGreaterThan(2);
  });

  it("speaks an unavailable timer naturally", () => {
    const [work] = formatPlannedIntervals([
      row({ recordedTimerDurationSeconds: null, timerDifferenceSeconds: null }),
    ]);
    expect(work?.powerSummary).toContain("Timer unavailable, 3:00 planned.");
    expect(work?.powerSummary).not.toContain("Timer Timer");
    expect(work?.powerSummary).not.toContain("Timer timer");
  });

  it("keys rows by source window since intervalIndex is local to each merged member", () => {
    const rows = formatPlannedIntervals([
      row({ intervalIndex: 0, startOffsetSeconds: 0, endOffsetSeconds: 180 }),
      row({ intervalIndex: 0, startOffsetSeconds: 600, endOffsetSeconds: 780 }),
    ]);
    expect(new Set(rows.map((item) => item.key)).size).toBe(2);
  });

  it("keeps FIT millisecond precision for fractional timing across the whole row", () => {
    const [work] = formatPlannedIntervals([
      row({
        plannedDurationSeconds: 180.2,
        recordedTimerDurationSeconds: 179.6,
        timerDifferenceSeconds: 179.6 - 180.2,
      }),
    ]);
    expect(work).toMatchObject({
      timer: "2:59.600",
      timerDetail: "0:00.600 short of 3:00.200",
      timerTone: "short",
    });
  });

  it("keeps whole-second rows as m:ss", () => {
    const [work] = formatPlannedIntervals([
      row({ recordedTimerDurationSeconds: 134, timerDifferenceSeconds: -46 }),
    ]);
    expect(work?.timer).toBe("2:14");
  });
});
