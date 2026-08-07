import { describe, expect, it } from "vitest";
import type { Insight } from "../components/CorrelationCard.tsx";
import { filterTrainingInsights, isTrainingInsight } from "./trainingInsights.ts";

function makeInsight(overrides: Partial<Insight> & Pick<Insight, "id" | "action">): Insight {
  return {
    type: "conditional",
    confidence: "strong",
    metric: "next-day heart rate variability",
    message: "Test insight",
    detail: "detail",
    whenTrue: { mean: 50, n: 10 },
    whenFalse: { mean: 40, n: 10 },
    effectSize: 0.5,
    pValue: 0.01,
    ...overrides,
  };
}

describe("isTrainingInsight", () => {
  it.each([
    "30+ min exercise",
    "10,000+ steps",
    "cardio day",
    "strength training day",
    "yoga/flexibility day",
    "12+ exercise days per month",
    "daily steps",
    "exercise duration",
    "monthly exercise volume",
  ])("matches training action %s", (action) => {
    expect(isTrainingInsight(action)).toBe(true);
  });

  it.each([
    "7+ hours of sleep",
    "100g+ protein",
    "2500+ calories",
    ">30% calories from protein",
    "consistent sleep schedule (< 30min variation)",
  ])("rejects non-training action %s", (action) => {
    expect(isTrainingInsight(action)).toBe(false);
  });
});

describe("filterTrainingInsights", () => {
  it("keeps training insights and drops insufficient confidence", () => {
    const insights = [
      makeInsight({ id: "training", action: "30+ min exercise", effectSize: 0.4 }),
      makeInsight({
        id: "insufficient",
        action: "cardio day",
        confidence: "insufficient",
        effectSize: 0.9,
      }),
      makeInsight({ id: "sleep", action: "7+ hours of sleep", effectSize: 0.8 }),
    ];

    const filtered = filterTrainingInsights(insights);

    expect(filtered.map((i) => i.id)).toEqual(["training"]);
  });

  it("sorts by absolute effect size descending", () => {
    const insights = [
      makeInsight({ id: "small", action: "cardio day", effectSize: 0.2 }),
      makeInsight({ id: "large-negative", action: "strength training day", effectSize: -0.7 }),
      makeInsight({ id: "medium", action: "10,000+ steps", effectSize: 0.5 }),
    ];

    const filtered = filterTrainingInsights(insights);

    expect(filtered.map((i) => i.id)).toEqual(["large-negative", "medium", "small"]);
  });
});
