import { describe, expect, it } from "vitest";
import { fitSleepTarget, type SleepTargetInput } from "./fit-sleep-target.ts";

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fitSleepTarget", () => {
  it("returns null with insufficient qualifying nights (< 14)", () => {
    const data: SleepTargetInput[] = [];
    for (let i = 0; i < 20; i++) {
      data.push({ durationMinutes: 450, nextDayHrvAboveMedian: i < 10 });
    }
    // Only 10 qualifying nights
    expect(fitSleepTarget(data)).toBeNull();
  });

  it("returns null with exactly 13 qualifying nights (boundary below MIN_QUALIFYING)", () => {
    const data: SleepTargetInput[] = [];
    for (let i = 0; i < 13; i++) {
      data.push({ durationMinutes: 450, nextDayHrvAboveMedian: true });
    }
    for (let i = 0; i < 20; i++) {
      data.push({ durationMinutes: 360, nextDayHrvAboveMedian: false });
    }
    expect(fitSleepTarget(data)).toBeNull();
  });

  it("processes exactly 14 qualifying nights (boundary at MIN_QUALIFYING)", () => {
    const data: SleepTargetInput[] = [];
    for (let i = 0; i < 14; i++) {
      data.push({ durationMinutes: 450, nextDayHrvAboveMedian: true });
    }
    for (let i = 0; i < 20; i++) {
      data.push({ durationMinutes: 360, nextDayHrvAboveMedian: false });
    }

    const result = fitSleepTarget(data);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.minutes).toBe(450);
    expect(result.sampleCount).toBe(14);
  });

  it("returns null with empty data", () => {
    expect(fitSleepTarget([])).toBeNull();
  });

  it("returns null when all nights are bad recovery", () => {
    const data: SleepTargetInput[] = [];
    for (let i = 0; i < 30; i++) {
      data.push({ durationMinutes: 360, nextDayHrvAboveMedian: false });
    }
    expect(fitSleepTarget(data)).toBeNull();
  });

  it("computes target from good-recovery nights", () => {
    const data: SleepTargetInput[] = [];
    // Good recovery nights: sleep 7.5 hours
    for (let i = 0; i < 20; i++) {
      data.push({ durationMinutes: 450, nextDayHrvAboveMedian: true });
    }
    // Bad recovery nights: sleep 6 hours
    for (let i = 0; i < 20; i++) {
      data.push({ durationMinutes: 360, nextDayHrvAboveMedian: false });
    }

    const result = fitSleepTarget(data);
    expect(result).not.toBeNull();
    if (!result) return;

    // Target should be ~450 minutes (average of good nights)
    expect(result.minutes).toBe(450);
    expect(result.sampleCount).toBe(20);
  });

  it("ignores bad-recovery nights when computing average", () => {
    const data: SleepTargetInput[] = [];
    // Good nights: all at 480 min
    for (let i = 0; i < 20; i++) {
      data.push({ durationMinutes: 480, nextDayHrvAboveMedian: true });
    }
    // Bad nights: very different duration, but should be excluded
    for (let i = 0; i < 100; i++) {
      data.push({ durationMinutes: 300, nextDayHrvAboveMedian: false });
    }

    const result = fitSleepTarget(data);
    expect(result).not.toBeNull();
    if (!result) return;

    // Only good nights contribute, so target should be exactly 480
    expect(result.minutes).toBe(480);
    expect(result.sampleCount).toBe(20);
  });

  it("returns reasonable target with mixed data", () => {
    const rng = mulberry32(42);
    const data: SleepTargetInput[] = [];

    for (let i = 0; i < 60; i++) {
      const duration = 360 + rng() * 180; // 6-9 hours
      // Better sleep → higher chance of good HRV
      const isGood = duration > 420 ? rng() > 0.3 : rng() > 0.7;
      data.push({ durationMinutes: Math.round(duration), nextDayHrvAboveMedian: isGood });
    }

    const result = fitSleepTarget(data);
    expect(result).not.toBeNull();
    if (!result) return;

    // Target should be between 6 and 9 hours
    expect(result.minutes).toBeGreaterThanOrEqual(360);
    expect(result.minutes).toBeLessThanOrEqual(540);
  });

  it("rounds target to whole minutes", () => {
    const data: SleepTargetInput[] = [];
    for (let i = 0; i < 15; i++) {
      data.push({ durationMinutes: 453, nextDayHrvAboveMedian: true });
    }
    for (let i = 0; i < 15; i++) {
      data.push({ durationMinutes: 454, nextDayHrvAboveMedian: true });
    }
    for (let i = 0; i < 20; i++) {
      data.push({ durationMinutes: 360, nextDayHrvAboveMedian: false });
    }

    const result = fitSleepTarget(data);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(Number.isInteger(result.minutes)).toBe(true);
  });

  it("rounds 453.5 average to 454 (standard rounding)", () => {
    const data: SleepTargetInput[] = [];
    // Equal split of 453 and 454 → average is 453.5 → rounds to 454
    for (let i = 0; i < 15; i++) {
      data.push({ durationMinutes: 453, nextDayHrvAboveMedian: true });
    }
    for (let i = 0; i < 15; i++) {
      data.push({ durationMinutes: 454, nextDayHrvAboveMedian: true });
    }

    const result = fitSleepTarget(data);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.minutes).toBe(454); // Math.round(453.5) = 454
    expect(result.sampleCount).toBe(30);
  });

  it("sampleCount only counts qualifying (good recovery) nights", () => {
    const data: SleepTargetInput[] = [];
    for (let i = 0; i < 25; i++) {
      data.push({ durationMinutes: 450, nextDayHrvAboveMedian: true });
    }
    for (let i = 0; i < 50; i++) {
      data.push({ durationMinutes: 360, nextDayHrvAboveMedian: false });
    }

    const result = fitSleepTarget(data);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.sampleCount).toBe(25); // only the good nights
  });
});
