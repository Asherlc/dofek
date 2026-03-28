import { describe, expect, it, vi } from "vitest";
import {
  BehaviorImpact,
  BehaviorImpactRepository,
  type BehaviorImpactRow,
} from "./behavior-impact-repository.ts";

describe("BehaviorImpact", () => {
  function makeRow(overrides: Partial<BehaviorImpactRow> = {}): BehaviorImpactRow {
    return {
      questionSlug: "alcohol",
      displayName: "Alcohol",
      category: "substance",
      avgReadinessYes: 55,
      avgReadinessNo: 70,
      yesCount: 10,
      noCount: 20,
      ...overrides,
    };
  }

  it("computes negative impact when yes readiness < no readiness", () => {
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 55, avgReadinessNo: 70 }));
    expect(impact.impactPercent).toBeCloseTo(-21.4, 1);
  });

  it("computes positive impact when yes readiness > no readiness", () => {
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 75, avgReadinessNo: 60 }));
    expect(impact.impactPercent).toBeCloseTo(25.0, 1);
  });

  it("returns 0 when avgReadinessNo is 0", () => {
    expect(new BehaviorImpact(makeRow({ avgReadinessNo: 0 })).impactPercent).toBe(0);
  });

  it("rounds to one decimal place", () => {
    // (65-60)/60 * 100 = 8.333... → 8.3
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 65, avgReadinessNo: 60 }));
    expect(impact.impactPercent).toBe(8.3);
  });

  it("serializes to API shape via toDetail()", () => {
    const impact = new BehaviorImpact(
      makeRow({ avgReadinessYes: 75, avgReadinessNo: 60, yesCount: 15, noCount: 12 }),
    );
    expect(impact.toDetail()).toEqual({
      questionSlug: "alcohol",
      displayName: "Alcohol",
      category: "substance",
      impactPercent: 25.0,
      yesCount: 15,
      noCount: 12,
    });
  });
});

describe("BehaviorImpactRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new BehaviorImpactRepository({ execute }, "user-1", "UTC");
    return { repo, execute };
  }

  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    expect(await repo.getImpactSummary(90)).toEqual([]);
  });

  it("returns BehaviorImpact instances", async () => {
    const { repo } = makeRepository([
      {
        question_slug: "meditation",
        display_name: "Meditation",
        category: "wellness",
        avg_readiness_yes: 75,
        avg_readiness_no: 60,
        yes_count: 15,
        no_count: 12,
      },
    ]);
    const result = await repo.getImpactSummary(90);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(BehaviorImpact);
    expect(result[0]?.impactPercent).toBeCloseTo(25.0, 1);
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getImpactSummary(30);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
