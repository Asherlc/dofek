import { describe, expect, it } from "vitest";
import { ProgressiveOverload } from "./progressive-overload.ts";

const DELOAD_CONTEXT =
  "Recorded volume cannot distinguish a planned deload from missed training or incomplete data.";

describe("ProgressiveOverload", () => {
  it("fits volume against actual elapsed calendar weeks and reports the observed period", () => {
    const detail = new ProgressiveOverload("Back Squat", [
      { week: "2026-01-05", totalVolumeKg: 1_000 },
      { week: "2026-01-19", totalVolumeKg: 1_200 },
      { week: "2026-02-02", totalVolumeKg: 1_400 },
    ]).toDetail();

    expect(detail.exerciseName).toBe("Back Squat");
    expect(detail.observations).toEqual([
      { week: "2026-01-05", totalVolumeKg: 1_000 },
      { week: "2026-01-19", totalVolumeKg: 1_200 },
      { week: "2026-02-02", totalVolumeKg: 1_400 },
    ]);
    expect(detail.slopeKgPerWeek).toBe(100);
    expect(detail.period).toEqual({
      startWeek: "2026-01-05",
      endWeek: "2026-02-02",
      observationCount: 3,
      elapsedWeekCount: 5,
    });
  });

  it("returns deterministic dependence-aware uncertainty when residual variation is estimable", () => {
    const observations = [
      { week: "2026-01-05", totalVolumeKg: 1_000 },
      { week: "2026-01-12", totalVolumeKg: 1_180 },
      { week: "2026-01-19", totalVolumeKg: 1_090 },
      { week: "2026-01-26", totalVolumeKg: 1_360 },
      { week: "2026-02-02", totalVolumeKg: 1_310 },
      { week: "2026-02-09", totalVolumeKg: 1_520 },
    ];

    const first = new ProgressiveOverload("Deadlift", observations).toDetail().uncertainty;
    const second = new ProgressiveOverload("Deadlift", observations).toDetail().uncertainty;

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      availability: "available",
      level: 0.95,
      method: "residual_circular_moving_block_bootstrap",
      methodLabel: "95% moving-block interval",
    });
    if (first.availability !== "available") {
      throw new Error("Expected available uncertainty");
    }
    expect(first.lowerKgPerWeek).toBeLessThanOrEqual(first.upperKgPerWeek);
    expect(Number.isFinite(first.lowerKgPerWeek)).toBe(true);
    expect(Number.isFinite(first.upperKgPerWeek)).toBe(true);
    expect(first.statement).toContain("recorded weeks");
    expect(first.statement).toContain("short-range dependence");
  });

  it("reports why uncertainty is unavailable with too few observations", () => {
    const detail = new ProgressiveOverload("Row", [
      { week: "2026-01-05", totalVolumeKg: 500 },
      { week: "2026-01-12", totalVolumeKg: 550 },
      { week: "2026-01-19", totalVolumeKg: 525 },
    ]).toDetail();

    expect(detail.uncertainty).toEqual({
      availability: "unavailable",
      level: 0.95,
      method: "residual_circular_moving_block_bootstrap",
      methodLabel: "95% moving-block interval",
      reason: "insufficient_observations",
      statement: "Uncertainty needs at least 4 recorded weeks; this estimate has 3.",
    });
  });

  it("does not present a perfect short series as certain", () => {
    const detail = new ProgressiveOverload("Bench Press", [
      { week: "2026-01-05", totalVolumeKg: 500 },
      { week: "2026-01-12", totalVolumeKg: 600 },
      { week: "2026-01-19", totalVolumeKg: 700 },
      { week: "2026-01-26", totalVolumeKg: 800 },
    ]).toDetail();

    expect(detail.uncertainty).toMatchObject({
      availability: "unavailable",
      reason: "no_residual_variation",
    });
  });

  it.each([
    {
      exerciseName: "Squat",
      volumes: [1_000, 1_100, 1_200, 1_300],
      trend: "increasing",
      direction: "increased",
    },
    {
      exerciseName: "Curl",
      volumes: [800, 700, 600, 500],
      trend: "decreasing",
      direction: "decreased",
    },
    {
      exerciseName: "Row",
      volumes: [600, 600, 600, 600],
      trend: "stable",
      direction: "was stable",
    },
  ] as const)(
    "authors neutral $trend interpretation and explicit deload context",
    ({ exerciseName, volumes, trend, direction }) => {
      const detail = new ProgressiveOverload(
        exerciseName,
        volumes.map((totalVolumeKg, index) => ({
          week: `2026-01-${String(5 + index * 7).padStart(2, "0")}`,
          totalVolumeKg,
        })),
      ).toDetail();

      expect(detail.trend).toBe(trend);
      expect(detail.interpretation).toContain(`Recorded weekly volume ${direction}`);
      expect(detail.interpretation).toContain("not inherently good or bad");
      expect(detail.deloadContext).toBe(DELOAD_CONTEXT);
    },
  );
});
