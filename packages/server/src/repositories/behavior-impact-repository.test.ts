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
      providerIds: ["manual_review"],
      ...overrides,
    };
  }

  it("computes negative impact when yes readiness < no readiness", () => {
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 55, avgReadinessNo: 70 }));
    expect(impact.impactPercent).toBeCloseTo(-21.4, 1);
    expect(impact.association.direction).toBe("lower");
  });

  it("computes positive impact when yes readiness > no readiness", () => {
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 75, avgReadinessNo: 60 }));
    expect(impact.impactPercent).toBeCloseTo(25.0, 1);
    expect(impact.association.direction).toBe("higher");
  });

  it("uses a neutral direction when the group means are equal", () => {
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 60, avgReadinessNo: 60 }));
    expect(impact.association.direction).toBe("no_difference");
  });

  it("derives direction from raw means when the displayed difference rounds to zero", () => {
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 60.0001, avgReadinessNo: 60 }));

    expect(impact.impactPercent).toBe(0);
    expect(impact.association.direction).toBe("higher");
    expect(impact.association.estimateLabel).toBe("0.0% difference");
  });

  it("represents a zero No-group baseline as an unavailable association", () => {
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 65, avgReadinessNo: 0 }));

    expect(impact.impactPercent).toBeNull();
    expect(impact.association).toMatchObject({
      direction: "unavailable",
      estimateLabel: "Estimate unavailable",
    });
    expect(impact.association.direction).not.toBe("no_difference");
  });

  it("rounds to one decimal place", () => {
    // (65-60)/60 * 100 = 8.333... → 8.3
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 65, avgReadinessNo: 60 }));
    expect(impact.impactPercent).toBe(8.3);
  });

  it("computes impactPercent with exact formula: round((yes-no)/no * 1000) / 10", () => {
    // (72 - 68) / 68 * 1000 = 58.8235... → round = 59 → /10 = 5.9
    const impact = new BehaviorImpact(makeRow({ avgReadinessYes: 72, avgReadinessNo: 68 }));
    expect(impact.impactPercent).toBe(5.9);
  });

  it("exposes all getters correctly", () => {
    const impact = new BehaviorImpact(
      makeRow({
        questionSlug: "caffeine",
        displayName: "Caffeine",
        category: "diet",
        yesCount: 42,
        noCount: 33,
      }),
    );
    expect(impact.questionSlug).toBe("caffeine");
    expect(impact.displayName).toBe("Caffeine");
    expect(impact.category).toBe("diet");
    expect(impact.yesCount).toBe(42);
    expect(impact.noCount).toBe(33);
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
      sources: [{ providerId: "manual_review", label: "Manual review" }],
      association: {
        relationship: "descriptive_association",
        direction: "higher",
        estimateLabel: "25.0% higher",
        method: "Relative difference in mean next-day readiness after Yes versus No.",
        interpretation:
          "This observational association does not establish that the behavior caused the readiness difference or prescribe a behavior change.",
        uncertainty: "Uncertainty interval is unavailable for this descriptive comparison.",
      },
    });
  });

  it("sorts and resolves every contributing provider as source provenance", () => {
    const impact = new BehaviorImpact(
      makeRow({ providerIds: ["whoop", "manual_review", "manual_review"] }),
    );

    expect(impact.sources).toEqual([
      { providerId: "manual_review", label: "Manual review" },
      { providerId: "whoop", label: "WHOOP (Cloud)" },
    ]);
  });
});

describe("BehaviorImpactRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const sensorStore = {
      query: vi.fn().mockResolvedValue([{ date: "2024-01-01", resting_hr: 52 }]),
    };
    const repo = new BehaviorImpactRepository({ execute }, "user-1", "UTC", sensorStore);
    return { repo, execute, sensorStore };
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
        provider_ids: ["manual_review"],
      },
    ]);
    const result = await repo.getImpactSummary(90);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(BehaviorImpact);
    expect(result[0]?.impactPercent).toBeCloseTo(25.0, 1);
  });

  it("maps all DB row fields to correct BehaviorImpact properties", async () => {
    const { repo } = makeRepository([
      {
        question_slug: "stretching",
        display_name: "Stretching",
        category: "exercise",
        avg_readiness_yes: 80,
        avg_readiness_no: 65,
        yes_count: 25,
        no_count: 18,
        provider_ids: ["manual_review"],
      },
    ]);
    const result = await repo.getImpactSummary(90);
    const impact = result[0];
    expect(impact?.questionSlug).toBe("stretching");
    expect(impact?.displayName).toBe("Stretching");
    expect(impact?.category).toBe("exercise");
    expect(impact?.yesCount).toBe(25);
    expect(impact?.noCount).toBe(18);
  });

  it("maps avgReadinessYes and avgReadinessNo to Number correctly", async () => {
    const { repo } = makeRepository([
      {
        question_slug: "sleep_mask",
        display_name: "Sleep Mask",
        category: "sleep",
        avg_readiness_yes: "72.5",
        avg_readiness_no: "68.3",
        yes_count: "10",
        no_count: "12",
        provider_ids: ["manual_review"],
      },
    ]);
    const result = await repo.getImpactSummary(90);
    const detail = result[0]?.toDetail();
    // impactPercent = round((72.5 - 68.3) / 68.3 * 1000) / 10
    // = round(4.2 / 68.3 * 1000) / 10 = round(61.493...) / 10 = 61 / 10 = 6.1
    expect(detail?.impactPercent).toBe(6.1);
    expect(detail?.yesCount).toBe(10);
    expect(detail?.noCount).toBe(12);
  });

  it("maps multiple DB rows to multiple BehaviorImpact instances", async () => {
    const { repo } = makeRepository([
      {
        question_slug: "a",
        display_name: "A",
        category: "cat1",
        avg_readiness_yes: 50,
        avg_readiness_no: 50,
        yes_count: 5,
        no_count: 5,
        provider_ids: ["manual_review"],
      },
      {
        question_slug: "b",
        display_name: "B",
        category: "cat2",
        avg_readiness_yes: 60,
        avg_readiness_no: 40,
        yes_count: 8,
        no_count: 7,
        provider_ids: ["whoop", "manual_review"],
      },
    ]);
    const result = await repo.getImpactSummary(90);
    expect(result).toHaveLength(2);
    expect(result[0]?.questionSlug).toBe("a");
    expect(result[1]?.questionSlug).toBe("b");
    expect(result[1]?.displayName).toBe("B");
    expect(result[1]?.category).toBe("cat2");
    expect(result[1]?.sources).toEqual([
      { providerId: "manual_review", label: "Manual review" },
      { providerId: "whoop", label: "WHOOP (Cloud)" },
    ]);
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getImpactSummary(30);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
