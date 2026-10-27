import type { Insight } from "../components/CorrelationCard.tsx";

export function isTrainingInsight(action: string): boolean {
  return /exercise|steps|cardio|strength|yoga|flexibility/i.test(action);
}

export function filterTrainingInsights(insights: Insight[]): Insight[] {
  return insights
    .filter((i) => i.confidence !== "insufficient" && isTrainingInsight(i.action))
    .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
}
